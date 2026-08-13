#!/usr/bin/env python3
"""Incremental timer and recorder for a Douyin recommendation-feed RPA run.

The browser/RPA layer supplies one JSON observation at a time.  This module
keeps the timer durable in SQLite, mirrors every observation to CSV, and can
resume an active session after a process or browser interruption.

Examples:
    python3 douyin_rpa_collector.py start --target 100
    python3 douyin_rpa_collector.py start --target 500 --all-videos --new
    python3 douyin_rpa_collector.py record --json '{"title":"..."}'
    python3 douyin_rpa_collector.py status
    python3 douyin_rpa_collector.py finish
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "douyin_rpa_session.sqlite"
DEFAULT_CSV = ROOT / "douyin_rpa_observations.csv"
DEFAULT_TARGET_CSV = ROOT / "douyin_rpa_target_100.csv"

CSV_FIELDS = [
    "observation_id",
    "session_id",
    "observed_at",
    "elapsed_seconds",
    "feed_index",
    "target_index",
    "is_relevant",
    "decision",
    "action",
    "user_liked",
    "user_favorited",
    "user_commented",
    "user_followed",
    "profile_check_attempted",
    "profile_tag_hit",
    "profile_visible_labels",
    "profile_check_url",
    "profile_return_ok",
    "user_comment_text",
    "user_action_reason",
    "user_action_result",
    "dwell_seconds",
    "interest_score",
    "title",
    "caption",
    "author",
    "author_href",
    "aweme_id",
    "hashtags",
    "matched_keywords",
    "duration_seconds",
    "current_position_seconds",
    "like_count",
    "comment_count",
    "share_count",
    "favorite_count",
    "before_url",
    "after_url",
    "scroll_delta",
    "transition_ok",
    "rpa_feedback",
    "raw_json",
]

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    multiplier = 1.0
    if text.endswith("万"):
        text = text[:-1]
        multiplier = 10000.0
    try:
        return float(text) * multiplier
    except ValueError:
        return None


def parse_clock(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    try:
        pieces = [float(part) for part in text.split(":")]
    except ValueError:
        return None
    if len(pieces) == 2:
        return pieces[0] * 60 + pieces[1]
    if len(pieces) == 3:
        return pieces[0] * 3600 + pieces[1] * 60 + pieces[2]
    return None


def db_connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            started_epoch REAL NOT NULL,
            target_count INTEGER NOT NULL,
            count_mode TEXT NOT NULL DEFAULT 'relevant',
            status TEXT NOT NULL CHECK (status IN ('active','finished')),
            finished_at TEXT,
            elapsed_seconds REAL,
            notes TEXT
        );
        CREATE TABLE IF NOT EXISTS observations (
            observation_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(session_id),
            observed_at TEXT NOT NULL,
            elapsed_seconds REAL NOT NULL,
            feed_index INTEGER NOT NULL,
            target_index INTEGER,
            is_relevant INTEGER NOT NULL,
            decision TEXT NOT NULL,
            action TEXT NOT NULL,
            user_liked INTEGER NOT NULL DEFAULT 0,
            user_favorited INTEGER NOT NULL DEFAULT 0,
            user_commented INTEGER NOT NULL DEFAULT 0,
            user_followed INTEGER NOT NULL DEFAULT 0,
            profile_check_attempted INTEGER,
            profile_tag_hit INTEGER,
            profile_visible_labels TEXT,
            profile_check_url TEXT,
            profile_return_ok INTEGER,
            user_comment_text TEXT,
            user_action_reason TEXT,
            user_action_result TEXT NOT NULL DEFAULT '{}',
            dwell_seconds REAL,
            interest_score REAL,
            title TEXT,
            caption TEXT,
            author TEXT,
            author_href TEXT,
            aweme_id TEXT,
            hashtags TEXT,
            matched_keywords TEXT,
            duration_seconds REAL,
            current_position_seconds REAL,
            like_count REAL,
            comment_count REAL,
            share_count REAL,
            favorite_count REAL,
            before_url TEXT,
            after_url TEXT,
            scroll_delta INTEGER,
            transition_ok INTEGER,
            rpa_feedback TEXT,
            raw_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, feed_index);
        CREATE INDEX IF NOT EXISTS idx_observations_target ON observations(session_id, target_index);
        """
    )
    session_columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if "count_mode" not in session_columns:
        conn.execute("ALTER TABLE sessions ADD COLUMN count_mode TEXT NOT NULL DEFAULT 'relevant'")
    observation_columns = {row[1] for row in conn.execute("PRAGMA table_info(observations)").fetchall()}
    for column, definition in (
        ("user_liked", "INTEGER NOT NULL DEFAULT 0"),
        ("user_favorited", "INTEGER NOT NULL DEFAULT 0"),
        ("user_commented", "INTEGER NOT NULL DEFAULT 0"),
        ("user_followed", "INTEGER NOT NULL DEFAULT 0"),
        ("profile_check_attempted", "INTEGER"),
        ("profile_tag_hit", "INTEGER"),
        ("profile_visible_labels", "TEXT"),
        ("profile_check_url", "TEXT"),
        ("profile_return_ok", "INTEGER"),
        ("user_comment_text", "TEXT"),
        ("user_action_reason", "TEXT"),
        ("user_action_result", "TEXT NOT NULL DEFAULT '{}'"),
    ):
        if column not in observation_columns:
            conn.execute(f"ALTER TABLE observations ADD COLUMN {column} {definition}")
    conn.commit()
    return conn


def csv_header_if_needed(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.stat().st_size == 0:
        with path.open("w", newline="", encoding="utf-8-sig") as handle:
            csv.DictWriter(handle, fieldnames=CSV_FIELDS).writeheader()


def append_csv(path: Path, row: dict[str, Any]) -> None:
    csv_header_if_needed(path)
    with path.open("a", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writerow({field: row.get(field, "") for field in CSV_FIELDS})
        handle.flush()


def active_session(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM sessions WHERE status='active' ORDER BY started_epoch DESC LIMIT 1"
    ).fetchone()


def ensure_session(conn: sqlite3.Connection, target: int, force_new: bool = False, count_mode: str = "relevant") -> sqlite3.Row:
    if not force_new:
        existing = active_session(conn)
        if existing:
            return existing
    session_id = uuid.uuid4().hex
    started_epoch = time.time()
    conn.execute(
        "INSERT INTO sessions(session_id, started_at, started_epoch, target_count, count_mode, status) VALUES (?, ?, ?, ?, ?, 'active')",
        (session_id, now_iso(), started_epoch, target, count_mode),
    )
    conn.commit()
    return conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()


def json_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, dict)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def flag(value: Any) -> int:
    if isinstance(value, str):
        return int(value.strip().lower() in {"1", "true", "yes", "y", "是"})
    return int(bool(value))


def normalized_record(data: dict[str, Any], session: sqlite3.Row, feed_index: int, target_index: int | None) -> dict[str, Any]:
    if "is_relevant" not in data:
        raise ValueError("is_relevant 必须由使用 AccountProfile 快照的浏览器分类器显式提供")
    relevant = bool(data["is_relevant"])
    score = float(data["interest_score"]) if data.get("interest_score") is not None else None
    matched = data.get("matched_keywords") or []
    if not relevant:
        target_index = None
    dwell = data.get("dwell_seconds")
    observed_at = str(data.get("observed_at") or now_iso())
    elapsed = data.get("elapsed_seconds")
    if elapsed is None:
        elapsed = max(0.0, time.time() - float(session["started_epoch"]))
    action_result = data.get("user_action_result") or {}
    if not isinstance(action_result, dict):
        action_result = {}
    feedback = data.get("rpa_feedback") or {}
    if not isinstance(feedback, dict):
        feedback = {}
    profile_check = feedback.get("profile_check") or data.get("profile_check") or {}
    if not isinstance(profile_check, dict):
        profile_check = {}
    profile_attempted = data.get("profile_check_attempted")
    if profile_attempted is None and "attempted" in profile_check:
        profile_attempted = flag(profile_check.get("attempted"))
    profile_tag_hit = data.get("profile_tag_hit")
    if profile_tag_hit is None and profile_attempted is not None and "tag_hit" in profile_check:
        profile_tag_hit = flag(profile_check.get("tag_hit"))
    profile_return_ok = data.get("profile_return_ok")
    if profile_return_ok is None and profile_attempted is not None and "return_ok" in profile_check:
        profile_return_ok = flag(profile_check.get("return_ok"))
    commented = data.get("user_commented")
    if commented is None:
        commented = action_result.get("commented", False)
    comment_text = (
        data.get("user_comment_text")
        or data.get("comment_text")
        or action_result.get("comment_text")
        or ""
    )
    row: dict[str, Any] = {
        "observation_id": str(data.get("observation_id") or uuid.uuid4().hex),
        "session_id": session["session_id"],
        "observed_at": observed_at,
        "elapsed_seconds": round(float(elapsed), 3),
        "feed_index": int(data.get("feed_index") or feed_index),
        "target_index": target_index,
        "is_relevant": int(relevant),
        "decision": str(data.get("decision") or ("keep" if relevant else "skip")),
        "action": str(data.get("action") or ("watch_then_next" if relevant else "skip")),
        "user_liked": flag(data.get("user_liked", False)),
        "user_favorited": flag(data.get("user_favorited", False)),
        "user_commented": flag(commented),
        "user_followed": flag(data.get("user_followed", False)),
        "profile_check_attempted": profile_attempted,
        "profile_tag_hit": profile_tag_hit,
        "profile_visible_labels": json_value(profile_check.get("visible_labels") or []),
        "profile_check_url": str(profile_check.get("profile_url") or ""),
        "profile_return_ok": profile_return_ok,
        "user_comment_text": str(comment_text),
        "user_action_reason": str(data.get("user_action_reason") or ""),
        "user_action_result": json_value(action_result),
        "dwell_seconds": round(float(dwell), 2) if dwell is not None else None,
        "interest_score": round(float(score), 3) if score is not None else None,
        "title": str(data.get("title") or ""),
        "caption": str(data.get("caption") or ""),
        "author": str(data.get("author") or ""),
        "author_href": str(data.get("author_href") or ""),
        "aweme_id": str(data.get("aweme_id") or ""),
        "hashtags": json_value(data.get("hashtags") or []),
        "matched_keywords": json_value(matched),
        "duration_seconds": parse_clock(data.get("duration_seconds")),
        "current_position_seconds": parse_clock(data.get("current_position_seconds")),
        "like_count": parse_number(data.get("like_count")),
        "comment_count": parse_number(data.get("comment_count")),
        "share_count": parse_number(data.get("share_count")),
        "favorite_count": parse_number(data.get("favorite_count")),
        "before_url": str(data.get("before_url") or ""),
        "after_url": str(data.get("after_url") or ""),
        "scroll_delta": int(data.get("scroll_delta") or 0),
        "transition_ok": int(bool(data.get("transition_ok", True))),
        "rpa_feedback": json_value(data.get("rpa_feedback") or {}),
        "raw_json": json.dumps(data, ensure_ascii=False, separators=(",", ":")),
    }
    row["record_hash"] = hashlib.sha256(row["raw_json"].encode("utf-8")).hexdigest()[:16]
    return row


def insert_record(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    fields = [field for field in CSV_FIELDS if field not in {"record_hash"}]
    db_fields = fields + ["created_at"]
    values = [row.get(field) for field in fields] + [now_iso()]
    placeholders = ",".join("?" for _ in db_fields)
    conn.execute(
        f"INSERT INTO observations({','.join(db_fields)}) VALUES ({placeholders})",
        values,
    )
    conn.commit()


def rebuild_csv_exports(conn: sqlite3.Connection, csv_path: Path, target_csv_path: Path) -> None:
    """Re-index target rows and rebuild both CSV mirrors from SQLite."""
    session_rows = conn.execute("SELECT session_id FROM sessions ORDER BY started_epoch").fetchall()
    for session_row in session_rows:
        target_index = 0
        observations = conn.execute(
            "SELECT observation_id, is_relevant, target_index FROM observations WHERE session_id=? ORDER BY feed_index, created_at",
            (session_row["session_id"],),
        ).fetchall()
        for observation in observations:
            if observation["is_relevant"]:
                target_index += 1
                new_index: int | None = target_index
            else:
                new_index = None
            if observation["target_index"] != new_index:
                conn.execute(
                    "UPDATE observations SET target_index=? WHERE observation_id=?",
                    (new_index, observation["observation_id"]),
                )
    conn.commit()
    rows = [dict(row) for row in conn.execute("SELECT * FROM observations ORDER BY created_at, feed_index")]
    for path, selected in ((csv_path, rows), (target_csv_path, [row for row in rows if row["is_relevant"]])):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
            writer.writeheader()
            for row in selected:
                writer.writerow({field: row.get(field, "") for field in CSV_FIELDS})


def counts(conn: sqlite3.Connection, session_id: str) -> tuple[int, int]:
    row = conn.execute(
        "SELECT COUNT(*) AS observed, COALESCE(SUM(is_relevant),0) AS relevant FROM observations WHERE session_id=?",
        (session_id,),
    ).fetchone()
    return int(row["observed"]), int(row["relevant"])


def command_start(args: argparse.Namespace) -> None:
    conn = db_connect(args.db)
    count_mode = "observed" if args.all_videos else "relevant"
    session = ensure_session(conn, args.target, args.new, count_mode)
    observed, relevant = counts(conn, session["session_id"])
    progress = observed if session["count_mode"] == "observed" else relevant
    print(json.dumps({
        "session_id": session["session_id"],
        "status": session["status"],
        "target": session["target_count"],
        "count_mode": session["count_mode"],
        "observed": observed,
        "relevant": relevant,
        "progress": progress,
        "started_at": session["started_at"],
        "elapsed_seconds": round(time.time() - float(session["started_epoch"]), 3),
    }, ensure_ascii=False))


def load_payload(raw: str | None, file: Path | None) -> Any:
    if raw and file:
        raise SystemExit("use only one of --json or --json-file")
    if file:
        text = file.read_text(encoding="utf-8")
        if file.suffix.lower() == ".jsonl":
            return [json.loads(line) for line in text.splitlines() if line.strip()]
        return json.loads(text)
    if raw:
        return json.loads(raw)
    return json.load(sys.stdin)


def command_record(args: argparse.Namespace) -> None:
    """Append one observation, or a small array of observations.

    Each item is committed to SQLite and appended to the CSV mirrors
    independently so a browser interruption cannot discard a whole batch.
    """
    conn = db_connect(args.db)
    session = active_session(conn)
    if session is None:
        raise SystemExit("no active session; run start first")
    payload = load_payload(args.json, args.json_file)
    payloads = payload if isinstance(payload, list) else [payload]
    if not payloads:
        raise SystemExit("record payload is empty")

    results: list[dict[str, Any]] = []
    for data in payloads:
        if not isinstance(data, dict):
            raise SystemExit("each record item must be a JSON object")
        observed, relevant = counts(conn, session["session_id"])
        feed_index = int(data.get("feed_index") or observed + 1)
        target_index = relevant + 1 if (data.get("is_relevant") is True or "is_relevant" not in data and classify(data)[3]) else None
        row = normalized_record(data, session, feed_index, target_index)
        # If an explicitly supplied relevance flag differs from automatic scoring,
        # keep the target sequence consistent with the final normalized value.
        if row["is_relevant"] and row["target_index"] is None:
            row["target_index"] = relevant + 1
        duplicate_of = None
        if row["aweme_id"]:
            duplicate_of = conn.execute(
                "SELECT observation_id FROM observations WHERE session_id=? AND aweme_id=? ORDER BY feed_index LIMIT 1",
                (session["session_id"], row["aweme_id"]),
            ).fetchone()
        if duplicate_of is not None:
            row["is_relevant"] = 0
            row["target_index"] = None
            row["decision"] = "duplicate_skip"
            row["action"] = "skip"
            feedback = json.loads(row["rpa_feedback"] or "{}")
            feedback["duplicate_of"] = duplicate_of["observation_id"]
            row["rpa_feedback"] = json.dumps(feedback, ensure_ascii=False, separators=(",", ":"))
        insert_record(conn, row)
        append_csv(args.csv, row)
        if row["is_relevant"]:
            append_csv(args.target_csv, row)
        observed += 1
        relevant += int(row["is_relevant"])
        progress = observed if session["count_mode"] == "observed" else relevant
        results.append({
            "ok": True,
            "observation_id": row["observation_id"],
            "session_id": row["session_id"],
            "feed_index": row["feed_index"],
            "target_index": row["target_index"],
            "observed": observed,
            "relevant": relevant,
            "target": session["target_count"],
            "count_mode": session["count_mode"],
            "elapsed_seconds": row["elapsed_seconds"],
            "dwell_seconds": row["dwell_seconds"],
            "progress": progress,
            "completed": progress >= int(session["target_count"]),
        })

    output: dict[str, Any] = results[0] if len(results) == 1 else {
        "ok": True,
        "recorded": len(results),
        "first_feed_index": results[0]["feed_index"],
        "last": results[-1],
    }
    print(json.dumps(output, ensure_ascii=False))


def command_status(args: argparse.Namespace) -> None:
    conn = db_connect(args.db)
    session = active_session(conn)
    if session is None:
        row = conn.execute("SELECT * FROM sessions ORDER BY started_epoch DESC LIMIT 1").fetchone()
        print(json.dumps({"status": "none" if row is None else row["status"]}, ensure_ascii=False))
        return
    observed, relevant = counts(conn, session["session_id"])
    progress = observed if session["count_mode"] == "observed" else relevant
    print(json.dumps({
        "session_id": session["session_id"],
        "status": session["status"],
        "target": session["target_count"],
        "count_mode": session["count_mode"],
        "observed": observed,
        "relevant": relevant,
        "progress": progress,
        "remaining": max(0, int(session["target_count"]) - progress),
        "completed": progress >= int(session["target_count"]),
        "elapsed_seconds": round(time.time() - float(session["started_epoch"]), 3),
    }, ensure_ascii=False))


def command_amend(args: argparse.Namespace) -> None:
    conn = db_connect(args.db)
    row = conn.execute(
        "SELECT * FROM observations WHERE observation_id=?",
        (args.observation_id,),
    ).fetchone()
    if row is None:
        raise SystemExit("observation not found")
    relevant = 1 if args.relevant else 0
    decision = args.decision or ("keep" if relevant else "skip")
    action = args.action or ("watch_then_next" if relevant else "skip")
    feedback: dict[str, Any] = {}
    try:
        feedback = json.loads(row["rpa_feedback"] or "{}")
    except (TypeError, json.JSONDecodeError):
        feedback = {}
    # Preserve the original browser/RPA evidence when correcting a label.
    # Older rows may already have a replacement feedback object, so recover
    # the original payload from raw_json when available.
    if row["raw_json"]:
        try:
            original = json.loads(row["raw_json"]).get("rpa_feedback") or {}
            if isinstance(original, dict):
                merged = dict(original)
                merged.update(feedback)
                feedback = merged
        except (TypeError, json.JSONDecodeError):
            pass
    feedback["manual_correction"] = True
    feedback["reason"] = args.reason or ""
    target_index = row["target_index"] if relevant else None
    user_commented = row["user_commented"] if args.commented is None else flag(args.commented)
    user_comment_text = row["user_comment_text"] if args.comment_text is None else args.comment_text
    conn.execute(
        "UPDATE observations SET is_relevant=?, target_index=?, decision=?, action=?, user_commented=?, user_comment_text=?, dwell_seconds=COALESCE(?, dwell_seconds), interest_score=COALESCE(?, interest_score), rpa_feedback=? WHERE observation_id=?",
        (
            relevant,
            target_index,
            decision,
            action,
            user_commented,
            user_comment_text,
            args.dwell,
            args.score,
            json.dumps(feedback, ensure_ascii=False, separators=(",", ":")),
            args.observation_id,
        ),
    )
    rebuild_csv_exports(conn, args.csv, args.target_csv)
    session = conn.execute("SELECT session_id FROM observations WHERE observation_id=?", (args.observation_id,)).fetchone()
    observed, relevant_count = counts(conn, session["session_id"])
    print(json.dumps({
        "ok": True,
        "observation_id": args.observation_id,
        "session_id": session["session_id"],
        "observed": observed,
        "relevant": relevant_count,
    }, ensure_ascii=False))


def command_finish(args: argparse.Namespace) -> None:
    conn = db_connect(args.db)
    session = active_session(conn)
    if session is None:
        raise SystemExit("no active session")
    elapsed = max(0.0, time.time() - float(session["started_epoch"]))
    conn.execute(
        "UPDATE sessions SET status='finished', finished_at=?, elapsed_seconds=? WHERE session_id=?",
        (now_iso(), elapsed, session["session_id"]),
    )
    conn.commit()
    observed, relevant = counts(conn, session["session_id"])
    progress = observed if session["count_mode"] == "observed" else relevant
    print(json.dumps({
        "ok": True,
        "session_id": session["session_id"],
        "observed": observed,
        "relevant": relevant,
        "target": session["target_count"],
        "count_mode": session["count_mode"],
        "elapsed_seconds": round(elapsed, 3),
        "progress": progress,
        "completed": progress >= int(session["target_count"]),
    }, ensure_ascii=False))


def command_rebuild(args: argparse.Namespace) -> None:
    """Regenerate CSV mirrors from SQLite without changing observation facts."""
    conn = db_connect(args.db)
    rebuild_csv_exports(conn, args.csv, args.target_csv)
    row = conn.execute(
        "SELECT COUNT(*) AS observed, COALESCE(SUM(is_relevant), 0) AS relevant FROM observations"
    ).fetchone()
    print(json.dumps({
        "ok": True,
        "observed": int(row["observed"]),
        "relevant": int(row["relevant"]),
        "csv": str(args.csv),
        "target_csv": str(args.target_csv),
    }, ensure_ascii=False))


def command_sample_dwell(args: argparse.Namespace) -> None:
    print(json.dumps({
        "dwell_seconds": sample_dwell_seconds(args.relevant, args.score),
        "distribution": "truncated_normal",
        "relevant": args.relevant,
    }, ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--target-csv", type=Path, default=DEFAULT_TARGET_CSV)
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="start or resume a session")
    start.add_argument("--target", type=int, default=100)
    start.add_argument("--new", action="store_true", help="force a new session")
    start.add_argument("--all-videos", action="store_true", help="complete when observed candidates reach target, not when relevant count reaches target")
    start.set_defaults(func=command_start)

    record = sub.add_parser("record", help="append one observation")
    record.add_argument("--json")
    record.add_argument("--json-file", type=Path)
    record.set_defaults(func=command_record)

    status = sub.add_parser("status", help="show current progress")
    status.set_defaults(func=command_status)

    amend = sub.add_parser("amend", help="correct one already-saved observation and rebuild CSV mirrors")
    amend.add_argument("--observation-id", required=True)
    relevance = amend.add_mutually_exclusive_group(required=True)
    relevance.add_argument("--relevant", action="store_true")
    relevance.add_argument("--irrelevant", action="store_true")
    amend.add_argument("--decision")
    amend.add_argument("--action")
    amend.add_argument("--dwell", type=float)
    amend.add_argument("--score", type=float)
    amend.add_argument("--reason")
    amend.add_argument("--commented", action=argparse.BooleanOptionalAction, default=None)
    amend.add_argument("--comment-text")
    amend.set_defaults(func=command_amend)

    finish = sub.add_parser("finish", help="stop the timer and close the active session")
    finish.set_defaults(func=command_finish)

    rebuild = sub.add_parser("rebuild", help="rebuild CSV mirrors from SQLite without altering records")
    rebuild.set_defaults(func=command_rebuild)

    dwell = sub.add_parser("sample-dwell", help="sample a bounded normal-distribution dwell time")
    dwell.add_argument("--relevant", action="store_true")
    dwell.add_argument("--score", type=float, default=0.0)
    dwell.set_defaults(func=command_sample_dwell)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
