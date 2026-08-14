from __future__ import annotations

import json
import sqlite3
import time
from typing import Any


BOOLEAN_FIELDS = {
    "is_relevant",
    "profile_check_attempted",
    "profile_tag_hit",
    "profile_return_ok",
    "transition_ok",
    "user_commented",
    "user_favorited",
    "user_followed",
    "user_liked",
}
JSON_FIELDS = {
    "hashtags",
    "matched_keywords",
    "profile_visible_labels",
    "rpa_feedback",
    "user_action_result",
}


def ensure_outbox_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS outbox (
            record_id TEXT PRIMARY KEY REFERENCES observations(observation_id),
            session_id TEXT NOT NULL REFERENCES sessions(session_id),
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','dead')),
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at REAL NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at REAL NOT NULL,
            sent_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_due
            ON outbox(status, next_retry_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_session
            ON outbox(session_id, status, created_at);
        """
    )


def _json_value(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return default


def record_payload(row: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    source = dict(row)
    payload: dict[str, Any] = {
        "contract_version": 2,
        "record_id": str(source["observation_id"]),
    }
    for key, value in source.items():
        if key in {"observation_id", "created_at", "raw_json", "record_hash"}:
            continue
        if key in BOOLEAN_FIELDS:
            payload[key] = None if value is None else bool(value)
        elif key in JSON_FIELDS:
            payload[key] = _json_value(value, {} if key in {"rpa_feedback", "user_action_result"} else [])
        else:
            payload[key] = value
    payload["raw_browser_observation"] = _json_value(source.get("raw_json"), {})
    return payload


def queue_record(conn: sqlite3.Connection, row: dict[str, Any] | sqlite3.Row) -> None:
    payload = record_payload(row)
    conn.execute(
        """
        INSERT INTO outbox(record_id, session_id, payload, status, attempts, next_retry_at, created_at)
        VALUES (?, ?, ?, 'pending', 0, 0, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          payload=excluded.payload,
          status=CASE WHEN outbox.status='sent' THEN 'sent' ELSE 'pending' END,
          next_retry_at=CASE WHEN outbox.status='sent' THEN outbox.next_retry_at ELSE 0 END,
          last_error=CASE WHEN outbox.status='sent' THEN outbox.last_error ELSE NULL END
        """,
        (
            payload["record_id"],
            payload["session_id"],
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            time.time(),
        ),
    )


def refresh_queued_record(conn: sqlite3.Connection, observation_id: str) -> None:
    status = conn.execute(
        "SELECT status FROM outbox WHERE record_id=?", (observation_id,)
    ).fetchone()
    if status is not None and status["status"] == "sent":
        raise ValueError("an uploaded observation is immutable; create a correction record instead")
    row = conn.execute(
        "SELECT * FROM observations WHERE observation_id=?", (observation_id,)
    ).fetchone()
    if row is None:
        raise ValueError("observation not found")
    queue_record(conn, row)
