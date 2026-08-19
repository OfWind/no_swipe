import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
COLLECTOR_PATH = (
    PLUGIN_ROOT
    / "skills"
    / "douyin-recommendation-rpa"
    / "scripts"
    / "douyin_rpa_collector.py"
)
SPEC = importlib.util.spec_from_file_location("no_swipe_sync_collector", COLLECTOR_PATH)
COLLECTOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(COLLECTOR)


class SyncAndRunnerStateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temporary.name) / "facts.sqlite"

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, argv: list[str]) -> dict:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            COLLECTOR.main(argv)
        return json.loads(buffer.getvalue())

    def test_sync_reports_local_counts_without_writing_csv(self):
        self.run_cli(["--db", str(self.db_path), "start", "--target", "2", "--new", "--all-videos"])
        self.run_cli([
            "--db",
            str(self.db_path),
            "record",
            "--json",
            json.dumps({
                "observation_id": "obs-sync-1",
                "run_id": "run-1",
                "config_hash": "sha256:abc",
                "is_relevant": True,
                "feed_index": 1,
                "observed_at": "2026-08-19T12:00:00Z",
                "title": "相关内容",
            }, ensure_ascii=False),
        ])
        synced = self.run_cli(["--db", str(self.db_path), "sync"])

        self.assertTrue(synced["ok"])
        self.assertEqual(synced["local"]["observed"], 1)
        self.assertEqual(synced["local"]["pending"], 1)
        self.assertEqual(synced["local"]["sent"], 0)
        self.assertIn(synced["mcp_upload"]["status"], {"deferred", "ready", "disabled"})
        self.assertEqual(list(Path(self.temporary.name).glob("*.csv")), [])

    def test_runner_state_returns_raw_observations(self):
        self.run_cli(["--db", str(self.db_path), "start", "--target", "2", "--new", "--all-videos"])
        self.run_cli([
            "--db",
            str(self.db_path),
            "record",
            "--json",
            json.dumps({
                "observation_id": "obs-state-1",
                "run_id": "run-1",
                "config_hash": "sha256:abc",
                "is_relevant": True,
                "feed_index": 1,
                "observed_at": "2026-08-19T12:00:00Z",
                "author": "creator-a",
                "user_followed": True,
            }, ensure_ascii=False),
        ])
        dumped = self.run_cli([
            "--db",
            str(self.db_path),
            "runner-state",
            "--run-id",
            "run-1",
            "--config-hash",
            "sha256:abc",
        ])
        self.assertEqual(len(dumped["observations"]), 1)
        self.assertEqual(dumped["observations"][0]["author"], "creator-a")
        self.assertEqual(dumped["observations"][0]["run_id"], "run-1")


if __name__ == "__main__":
    unittest.main()
