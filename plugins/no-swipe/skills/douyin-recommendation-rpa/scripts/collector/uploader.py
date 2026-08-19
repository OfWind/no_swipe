from __future__ import annotations

import json
import random
import sqlite3
import time
import urllib.error
import urllib.request
from typing import Any

from .auth import AuthClient, AuthError, AuthRequired
from .config import ConfigurationError, SupabaseConfig, load_config


MAX_ATTEMPTS = 8
MAX_REQUEST_BYTES = 400_000
DEFAULT_MCP_BATCH_SIZE = 10
DEFAULT_MCP_MIN_BATCH_SIZE = 10
DEFAULT_MCP_MAX_WAIT_SECONDS = 60.0


class UploadHttpError(RuntimeError):
    def __init__(self, status: int, payload: dict[str, Any]):
        super().__init__(str(payload.get("error") or payload.get("message") or f"HTTP {status}"))
        self.status = status
        self.payload = payload


def retry_delay(attempt: int, random_value: float | None = None) -> float:
    jitter = random.random() if random_value is None else random_value
    return min(3600.0, 5.0 * (2 ** max(0, attempt - 1))) * (0.75 + 0.5 * jitter)


def _response_json(raw: bytes) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("ingest returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise RuntimeError("ingest returned an invalid response")
    return value


def _encode_body(body: dict[str, Any]) -> bytes:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _post(config: SupabaseConfig, token: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        config.ingest_url,
        method="POST",
        headers={
            "apikey": config.publishable_key,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        data=_encode_body(body),
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return _response_json(response.read())
    except urllib.error.HTTPError as exc:
        try:
            payload = _response_json(exc.read())
        except RuntimeError:
            payload = {"error": f"HTTP {exc.code}"}
        raise UploadHttpError(exc.code, payload) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"cannot reach ingest endpoint: {exc}") from exc


def _batch_body(
    conn: sqlite3.Connection,
    config: SupabaseConfig,
    session_id: str,
    rows: list[sqlite3.Row],
) -> dict[str, Any]:
    session = conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    if session is None:
        raise RuntimeError("outbox references a missing session")
    totals = conn.execute(
        "SELECT COUNT(*) AS observed, COALESCE(SUM(is_relevant),0) AS relevant FROM observations WHERE session_id=?",
        (session_id,),
    ).fetchone()
    records = [json.loads(row["payload"]) for row in rows]
    return {
        "contract_version": config.contract_version,
        "session_id": session_id,
        "client": {
            "plugin_version": config.plugin_version,
            "host_fingerprint": config.host_fingerprint,
        },
        "task_config": {
            "target_count": session["target_count"],
            "count_mode": session["count_mode"],
        },
        "started_at": session["started_at"],
        "finished_at": session["finished_at"],
        "stats": {
            "observed": int(totals["observed"]),
            "relevant": int(totals["relevant"]),
            "elapsed_seconds": session["elapsed_seconds"],
        },
        "heartbeat": {
            "counters": {
                "observed": int(totals["observed"]),
                "relevant": int(totals["relevant"]),
                "outbox_batch": len(records),
            }
        },
        "records": records,
    }


def _mark_failure(conn: sqlite3.Connection, rows: list[sqlite3.Row], message: str, permanent: bool) -> None:
    now = time.time()
    for row in rows:
        attempts = int(row["attempts"]) + 1
        dead = permanent or attempts >= MAX_ATTEMPTS
        conn.execute(
            "UPDATE outbox SET status=?, attempts=?, next_retry_at=?, last_error=? WHERE record_id=?",
            (
                "dead" if dead else "failed",
                attempts,
                0 if dead else now + retry_delay(attempts),
                message[:500],
                row["record_id"],
            ),
        )
    conn.commit()


def queue_counts(conn: sqlite3.Connection) -> dict[str, int]:
    row = conn.execute(
        """
        SELECT
          COALESCE(SUM(CASE WHEN status IN ('pending','failed') THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END), 0) AS dead,
          COALESCE(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END), 0) AS sent
        FROM outbox
        """
    ).fetchone()
    return {key: int(row[key]) for key in ("pending", "dead", "sent")}


def prepare_mcp_batch(
    conn: sqlite3.Connection,
    batch_size: int = DEFAULT_MCP_BATCH_SIZE,
    config: SupabaseConfig | None = None,
    heartbeat_session_id: str | None = None,
    min_batch_size: int = DEFAULT_MCP_MIN_BATCH_SIZE,
    max_wait_seconds: float = DEFAULT_MCP_MAX_WAIT_SECONDS,
    force: bool = False,
) -> dict[str, Any]:
    """Return one due outbox batch when the micro-batch policy says it is ready.

    Local persistence is independent of this decision: every observation is
    already durable in SQLite/outbox before this function is called. The MCP
    caller can therefore keep collecting while a small, young batch is
    deferred, and force a flush at lifecycle boundaries.
    """
    if batch_size < 1 or batch_size > 100:
        raise ValueError("batch_size must be between 1 and 100")
    if min_batch_size < 1 or min_batch_size > batch_size:
        raise ValueError("min_batch_size must be between 1 and batch_size")
    if max_wait_seconds < 0:
        raise ValueError("max_wait_seconds must be non-negative")
    try:
        config = config or load_config()
    except ConfigurationError as exc:
        return {"status": "disabled", "reason": str(exc), **queue_counts(conn)}

    now = time.time()
    due_sessions = conn.execute(
        """
        SELECT
          session_id,
          COUNT(*) AS due_count,
          MIN(created_at) AS oldest_created_at
        FROM outbox
        WHERE status IN ('pending','failed') AND next_retry_at<=?
        GROUP BY session_id
        ORDER BY oldest_created_at
        """,
        (now,),
    ).fetchall()

    selected = next(
        (
            row
            for row in due_sessions
            if force
            or int(row["due_count"]) >= min_batch_size
            or now - float(row["oldest_created_at"]) >= max_wait_seconds
        ),
        None,
    )
    if selected is None and due_sessions:
        oldest = due_sessions[0]
        oldest_age = max(0.0, now - float(oldest["oldest_created_at"]))
        return {
            "status": "deferred",
            "reason": "micro_batch_not_due",
            "due_count": int(oldest["due_count"]),
            "min_batch_size": min_batch_size,
            "oldest_pending_age_seconds": round(oldest_age, 3),
            "due_in_seconds": round(max(0.0, max_wait_seconds - oldest_age), 3),
            **queue_counts(conn),
        }

    session_id = selected["session_id"] if selected is not None else heartbeat_session_id
    if not session_id:
        return {"status": "idle", **queue_counts(conn)}
    due_count = int(selected["due_count"]) if selected is not None else 0

    rows = conn.execute(
        """
        SELECT * FROM outbox
        WHERE session_id=? AND status IN ('pending','failed') AND next_retry_at<=?
        ORDER BY created_at LIMIT ?
        """,
        (session_id, now, batch_size),
    ).fetchall()
    body = _batch_body(conn, config, session_id, rows)
    while len(rows) > 1 and len(_encode_body(body)) > MAX_REQUEST_BYTES:
        rows = rows[:max(1, len(rows) // 2)]
        body = _batch_body(conn, config, session_id, rows)
    if len(_encode_body(body)) > MAX_REQUEST_BYTES:
        _mark_failure(
            conn,
            rows,
            f"record payload exceeds {MAX_REQUEST_BYTES} byte upload limit",
            permanent=True,
        )
        return {"status": "rejected", **queue_counts(conn)}

    return {
        "status": "ready",
        "ready_reason": (
            "heartbeat"
            if not rows
            else "forced"
            if force
            else "count_threshold"
            if due_count >= min_batch_size
            else "age_threshold"
        ),
        "tool": "ingest_observation_batch",
        "batch_record_ids": [row["record_id"] for row in rows],
        "arguments": body,
        **queue_counts(conn),
    }


def apply_mcp_ack(
    conn: sqlite3.Connection,
    batch_record_ids: list[str],
    response: dict[str, Any],
) -> dict[str, Any]:
    if len(set(batch_record_ids)) != len(batch_record_ids):
        raise ValueError("batch_record_ids contains duplicates")
    rows = {
        row["record_id"]: row
        for row in conn.execute(
            "SELECT * FROM outbox WHERE record_id IN (%s)" % ",".join("?" for _ in batch_record_ids),
            batch_record_ids,
        ).fetchall()
    } if batch_record_ids else {}
    if set(rows) != set(batch_record_ids):
        raise ValueError("acknowledgement references an unknown outbox record")

    accepted = {str(value) for value in response.get("accepted", [])}
    duplicated = {str(value) for value in response.get("duplicated", [])}
    rejected = {
        str(item.get("id")): str(item.get("reason", "rejected"))
        for item in response.get("rejected", [])
        if isinstance(item, dict) and item.get("id") is not None
    }
    acknowledged = accepted | duplicated | set(rejected)
    if not acknowledged.issubset(rows):
        raise ValueError("MCP response acknowledged a record outside this batch")

    now = time.time()
    for record_id, row in rows.items():
        attempts = int(row["attempts"]) + 1
        if record_id in accepted or record_id in duplicated:
            conn.execute(
                "UPDATE outbox SET status='sent', attempts=?, sent_at=?, next_retry_at=0, last_error=NULL WHERE record_id=?",
                (attempts, now, record_id),
            )
        elif record_id in rejected:
            conn.execute(
                "UPDATE outbox SET status='dead', attempts=?, next_retry_at=0, last_error=? WHERE record_id=?",
                (attempts, rejected[record_id][:500], record_id),
            )
        else:
            conn.execute(
                "UPDATE outbox SET status='failed', attempts=?, next_retry_at=?, last_error=? WHERE record_id=?",
                (attempts, now + retry_delay(attempts), "missing MCP acknowledgement", record_id),
            )
    conn.commit()
    return {
        "status": "ok",
        "accepted": len(accepted),
        "duplicated": len(duplicated),
        "rejected": len(rejected),
        **queue_counts(conn),
    }


def flush_pending(
    conn: sqlite3.Connection,
    batch_size: int = 100,
    config: SupabaseConfig | None = None,
    auth: AuthClient | None = None,
    max_batches: int = 20,
    heartbeat_session_id: str | None = None,
) -> dict[str, Any]:
    if batch_size < 1 or batch_size > 100:
        raise ValueError("batch_size must be between 1 and 100")
    try:
        config = config or load_config()
    except ConfigurationError as exc:
        return {"status": "disabled", "reason": str(exc), **queue_counts(conn)}
    auth = auth or AuthClient(config)
    try:
        token = auth.access_token()
    except AuthRequired:
        return {"status": "login_required", **queue_counts(conn)}
    except AuthError as exc:
        return {"status": "auth_error", "reason": str(exc), **queue_counts(conn)}

    summary = {"status": "ok", "accepted": 0, "duplicated": 0, "rejected": 0}
    for _ in range(max_batches):
        first = conn.execute(
            """
            SELECT session_id FROM outbox
            WHERE status IN ('pending','failed') AND next_retry_at<=?
            ORDER BY created_at LIMIT 1
            """,
            (time.time(),),
        ).fetchone()
        if first is None:
            break
        rows = conn.execute(
            """
            SELECT * FROM outbox
            WHERE session_id=? AND status IN ('pending','failed') AND next_retry_at<=?
            ORDER BY created_at LIMIT ?
            """,
            (first["session_id"], time.time(), batch_size),
        ).fetchall()
        if not rows:
            break
        body = _batch_body(conn, config, first["session_id"], rows)
        while len(rows) > 1 and len(_encode_body(body)) > MAX_REQUEST_BYTES:
            rows = rows[:max(1, len(rows) // 2)]
            body = _batch_body(conn, config, first["session_id"], rows)
        if len(_encode_body(body)) > MAX_REQUEST_BYTES:
            _mark_failure(
                conn,
                rows,
                f"record payload exceeds {MAX_REQUEST_BYTES} byte upload limit",
                permanent=True,
            )
            summary.update(status="rejected")
            summary["rejected"] += len(rows)
            continue
        try:
            response = _post(config, token, body)
        except UploadHttpError as exc:
            if exc.status == 401:
                try:
                    token = auth.access_token(force_refresh=True)
                    response = _post(config, token, body)
                except (AuthError, UploadHttpError, RuntimeError) as retry_exc:
                    _mark_failure(conn, rows, str(retry_exc), permanent=False)
                    summary.update(status="auth_error", reason=str(retry_exc))
                    break
            else:
                permanent = 400 <= exc.status < 500 and exc.status not in {408, 429}
                _mark_failure(conn, rows, str(exc), permanent=permanent)
                summary.update(status="rejected" if permanent else "retry_scheduled", reason=str(exc))
                if permanent:
                    summary["rejected"] += len(rows)
                break
        except RuntimeError as exc:
            _mark_failure(conn, rows, str(exc), permanent=False)
            summary.update(status="retry_scheduled", reason=str(exc))
            break

        accepted = {str(value) for value in response.get("accepted", [])}
        duplicated = {str(value) for value in response.get("duplicated", [])}
        rejected = {
            str(item.get("id")): str(item.get("reason", "rejected"))
            for item in response.get("rejected", [])
            if isinstance(item, dict)
        }
        known = {row["record_id"] for row in rows}
        if not (accepted | duplicated | set(rejected)).issubset(known):
            _mark_failure(conn, rows, "ingest acknowledged unknown record ids", permanent=False)
            summary.update(status="retry_scheduled", reason="invalid ingest acknowledgement")
            break

        now = time.time()
        for row in rows:
            record_id = row["record_id"]
            attempts = int(row["attempts"]) + 1
            if record_id in accepted or record_id in duplicated:
                conn.execute(
                    "UPDATE outbox SET status='sent', attempts=?, sent_at=?, next_retry_at=0, last_error=NULL WHERE record_id=?",
                    (attempts, now, record_id),
                )
            elif record_id in rejected:
                conn.execute(
                    "UPDATE outbox SET status='dead', attempts=?, next_retry_at=0, last_error=? WHERE record_id=?",
                    (attempts, rejected[record_id][:500], record_id),
                )
            else:
                conn.execute(
                    "UPDATE outbox SET status='failed', attempts=?, next_retry_at=?, last_error=? WHERE record_id=?",
                    (attempts, now + retry_delay(attempts), "missing acknowledgement", record_id),
                )
        conn.commit()
        summary["accepted"] += len(accepted)
        summary["duplicated"] += len(duplicated)
        summary["rejected"] += len(rejected)

    if heartbeat_session_id and summary["status"] == "ok":
        heartbeat_body = _batch_body(conn, config, heartbeat_session_id, [])
        try:
            _post(config, token, heartbeat_body)
            summary["heartbeat"] = "sent"
        except UploadHttpError as exc:
            if exc.status == 401:
                try:
                    token = auth.access_token(force_refresh=True)
                    _post(config, token, heartbeat_body)
                    summary["heartbeat"] = "sent"
                except (AuthError, UploadHttpError, RuntimeError) as retry_exc:
                    summary.update(status="heartbeat_retry_needed", heartbeat="pending", reason=str(retry_exc))
            else:
                summary.update(status="heartbeat_retry_needed", heartbeat="pending", reason=str(exc))
        except RuntimeError as exc:
            summary.update(status="heartbeat_retry_needed", heartbeat="pending", reason=str(exc))

    summary.update(queue_counts(conn))
    return summary
