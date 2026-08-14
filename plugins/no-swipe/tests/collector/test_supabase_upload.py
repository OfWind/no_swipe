import base64
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_ROOT = PLUGIN_ROOT / "skills" / "douyin-recommendation-rpa" / "scripts"
COLLECTOR_PATH = SCRIPTS_ROOT / "douyin_rpa_collector.py"
SPEC = importlib.util.spec_from_file_location("no_swipe_upload_collector", COLLECTOR_PATH)
COLLECTOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(COLLECTOR)

from collector.auth import AuthClient, AuthError  # noqa: E402
from collector.config import SupabaseConfig  # noqa: E402
from collector.outbox import refresh_queued_record  # noqa: E402
from collector import uploader  # noqa: E402


class FakeAuth:
    def access_token(self, force_refresh=False):
        return "test-user-jwt"


class MissingAuth:
    def access_token(self, force_refresh=False):
        from collector.auth import AuthRequired

        raise AuthRequired("not logged in")


class RefreshingAuth:
    def __init__(self):
        self.force_refresh_calls = 0

    def access_token(self, force_refresh=False):
        if force_refresh:
            self.force_refresh_calls += 1
            return "refreshed-user-jwt"
        return "expired-user-jwt"


class SupabaseUploadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.db_path = root / "facts.sqlite"
        self.conn = COLLECTOR.db_connect(self.db_path)
        self.session = COLLECTOR.ensure_session(self.conn, 10, True, "observed")
        self.config = SupabaseConfig(
            url="http://127.0.0.1:54321",
            publishable_key="sb_publishable_test_key",
            edge_function="ingest",
            contract_version=2,
            plugin_version="test",
        )

    def tearDown(self):
        self.conn.close()
        self.temporary.cleanup()

    def add_record(self, observation_id="record-1"):
        row = COLLECTOR.normalized_record(
            {
                "observation_id": observation_id,
                "is_relevant": True,
                "feed_index": 1,
                "observed_at": "2026-08-13T20:00:00+08:00",
                "decision": "keep",
                "action": "watch_then_next",
                "dwell_seconds": 2.5,
                "rpa_feedback": {"content_type": "video"},
            },
            self.session,
            1,
            1,
        )
        COLLECTOR.insert_record(self.conn, row)
        return row

    def test_observation_and_outbox_are_committed_together(self):
        self.add_record()
        observation = self.conn.execute("SELECT * FROM observations").fetchone()
        queued = self.conn.execute("SELECT * FROM outbox").fetchone()
        self.assertEqual(observation["observation_id"], queued["record_id"])
        payload = json.loads(queued["payload"])
        self.assertEqual(payload["contract_version"], 2)
        self.assertEqual(payload["record_id"], "record-1")
        self.assertTrue(payload["observed_at"].endswith("+08:00"))

    def test_accepted_and_duplicate_acknowledgements_mark_sent(self):
        self.add_record("accepted-1")
        with mock.patch.object(uploader, "_post", return_value={
            "accepted": ["accepted-1"], "duplicated": [], "rejected": []
        }):
            result = uploader.flush_pending(self.conn, config=self.config, auth=FakeAuth())
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(self.conn.execute(
            "SELECT status FROM outbox WHERE record_id='accepted-1'"
        ).fetchone()["status"], "sent")

        self.add_record("duplicate-2")
        with mock.patch.object(uploader, "_post", return_value={
            "accepted": [], "duplicated": ["duplicate-2"], "rejected": []
        }):
            result = uploader.flush_pending(self.conn, config=self.config, auth=FakeAuth())
        self.assertEqual(result["duplicated"], 1)
        self.assertEqual(self.conn.execute(
            "SELECT status FROM outbox WHERE record_id='duplicate-2'"
        ).fetchone()["status"], "sent")

    def test_network_failure_keeps_record_for_retry(self):
        self.add_record()
        with mock.patch.object(uploader, "_post", side_effect=RuntimeError("offline")):
            result = uploader.flush_pending(self.conn, config=self.config, auth=FakeAuth())
        queued = self.conn.execute("SELECT * FROM outbox WHERE record_id='record-1'").fetchone()
        self.assertEqual(result["status"], "retry_scheduled")
        self.assertEqual(queued["status"], "failed")
        self.assertEqual(queued["attempts"], 1)
        self.assertGreater(queued["next_retry_at"], time.time())

    def test_unauthorized_upload_refreshes_once_and_retries(self):
        self.add_record()
        auth = RefreshingAuth()
        with mock.patch.object(uploader, "_post", side_effect=[
            uploader.UploadHttpError(401, {"error": "invalid_session"}),
            {"accepted": ["record-1"], "duplicated": [], "rejected": []},
        ]) as post:
            result = uploader.flush_pending(self.conn, config=self.config, auth=auth)
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(auth.force_refresh_calls, 1)
        self.assertEqual(post.call_count, 2)

    def test_permanent_client_error_moves_record_to_dead(self):
        self.add_record()
        with mock.patch.object(
            uploader,
            "_post",
            side_effect=uploader.UploadHttpError(400, {"error": "invalid_record"}),
        ):
            result = uploader.flush_pending(self.conn, config=self.config, auth=FakeAuth())
        queued = self.conn.execute("SELECT * FROM outbox WHERE record_id='record-1'").fetchone()
        self.assertEqual(queued["status"], "dead")
        self.assertEqual(result["pending"], 0)
        self.assertEqual(result["dead"], 1)

    def test_retry_limit_moves_record_to_dead(self):
        self.add_record()
        self.conn.execute("UPDATE outbox SET attempts=7 WHERE record_id='record-1'")
        self.conn.commit()
        with mock.patch.object(uploader, "_post", side_effect=RuntimeError("offline")):
            result = uploader.flush_pending(self.conn, config=self.config, auth=FakeAuth())
        queued = self.conn.execute("SELECT * FROM outbox WHERE record_id='record-1'").fetchone()
        self.assertEqual(queued["status"], "dead")
        self.assertEqual(queued["attempts"], 8)
        self.assertEqual(result["pending"], 0)
        self.assertEqual(result["dead"], 1)

    def test_oversized_single_record_is_dead_without_network_attempt(self):
        self.add_record()
        queued = self.conn.execute("SELECT payload FROM outbox WHERE record_id='record-1'").fetchone()
        payload = json.loads(queued["payload"])
        payload["oversized_probe"] = "x" * uploader.MAX_REQUEST_BYTES
        self.conn.execute(
            "UPDATE outbox SET payload=? WHERE record_id='record-1'",
            (json.dumps(payload),),
        )
        self.conn.commit()
        with mock.patch.object(uploader, "_post") as post:
            result = uploader.flush_pending(self.conn, config=self.config, auth=FakeAuth())
        queued = self.conn.execute("SELECT * FROM outbox WHERE record_id='record-1'").fetchone()
        self.assertEqual(queued["status"], "dead")
        self.assertIn("byte upload limit", queued["last_error"])
        self.assertEqual(result["pending"], 0)
        self.assertEqual(result["dead"], 1)
        post.assert_not_called()

    def test_missing_login_never_consumes_an_attempt(self):
        self.add_record()
        result = uploader.flush_pending(self.conn, config=self.config, auth=MissingAuth())
        queued = self.conn.execute("SELECT * FROM outbox WHERE record_id='record-1'").fetchone()
        self.assertEqual(result["status"], "login_required")
        self.assertEqual(queued["status"], "pending")
        self.assertEqual(queued["attempts"], 0)

    def test_uploaded_observation_is_immutable(self):
        self.add_record()
        self.conn.execute("UPDATE outbox SET status='sent' WHERE record_id='record-1'")
        self.conn.commit()
        with self.assertRaisesRegex(ValueError, "immutable"):
            refresh_queued_record(self.conn, "record-1")

    def test_auth_cache_is_owner_only(self):
        auth_dir = Path(self.temporary.name) / "auth"
        auth = AuthClient(self.config, auth_dir=auth_dir)
        claims = base64.urlsafe_b64encode(json.dumps({
            "exp": int(time.time()) + 3600,
            "email": "tester@zhuanzhuan.com",
        }).encode()).decode().rstrip("=")
        auth.save_session({
            "access_token": f"header.{claims}.signature",
            "refresh_token": "refresh-value",
            "user": {"email": "tester@zhuanzhuan.com"},
        })
        self.assertEqual(os.stat(auth.auth_file).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(auth_dir).st_mode & 0o777, 0o700)

    def test_auth_otp_accepts_any_valid_email_and_can_create_user(self):
        auth = AuthClient(self.config, auth_dir=Path(self.temporary.name) / "auth")
        with mock.patch.object(auth, "_request", return_value={}) as request:
            auth.send_otp("  Tester@Example.COM ")
        request.assert_called_once_with(
            "/auth/v1/otp",
            {"email": "tester@example.com", "create_user": True},
        )

        for email in ("tester", "@example.com", "tester@"):
            with self.subTest(email=email), self.assertRaisesRegex(AuthError, "valid email"):
                auth.send_otp(email)

    def test_mcp_batch_and_ack_complete_the_durable_outbox_cycle(self):
        self.add_record("mcp-record-1")
        batch = uploader.prepare_mcp_batch(self.conn, config=self.config)
        self.assertEqual(batch["status"], "ready")
        self.assertEqual(batch["tool"], "ingest_observation_batch")
        self.assertEqual(batch["batch_record_ids"], ["mcp-record-1"])
        self.assertEqual(batch["arguments"]["records"][0]["record_id"], "mcp-record-1")

        result = uploader.apply_mcp_ack(
            self.conn,
            batch["batch_record_ids"],
            {"accepted": ["mcp-record-1"], "duplicated": [], "rejected": []},
        )
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(self.conn.execute(
            "SELECT status FROM outbox WHERE record_id='mcp-record-1'"
        ).fetchone()["status"], "sent")

    def test_mcp_ack_rejects_ids_outside_the_emitted_batch(self):
        self.add_record("mcp-record-1")
        with self.assertRaisesRegex(ValueError, "outside this batch"):
            uploader.apply_mcp_ack(
                self.conn,
                ["mcp-record-1"],
                {"accepted": ["different-record"], "duplicated": [], "rejected": []},
            )

    def test_finish_can_sync_session_without_pending_records(self):
        self.add_record()
        self.conn.execute("UPDATE outbox SET status='sent' WHERE record_id='record-1'")
        self.conn.execute(
            "UPDATE sessions SET status='finished', finished_at='2026-08-13T21:00:00+08:00', elapsed_seconds=60 WHERE session_id=?",
            (self.session["session_id"],),
        )
        self.conn.commit()
        with mock.patch.object(uploader, "_post", return_value={
            "accepted": [], "duplicated": [], "rejected": []
        }) as post:
            result = uploader.flush_pending(
                self.conn,
                config=self.config,
                auth=FakeAuth(),
                heartbeat_session_id=self.session["session_id"],
            )
        self.assertEqual(result["heartbeat"], "sent")
        self.assertEqual(post.call_args.args[2]["finished_at"], "2026-08-13T21:00:00+08:00")
        self.assertEqual(post.call_args.args[2]["records"], [])


if __name__ == "__main__":
    unittest.main()
