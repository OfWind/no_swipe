import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const CSV_FIELDS = [
  "observation_id", "session_id", "observed_at", "elapsed_seconds", "feed_index", "target_index",
  "is_relevant", "decision", "action", "user_liked", "user_favorited", "user_commented", "user_followed",
  "profile_check_attempted", "profile_tag_hit", "profile_visible_labels", "profile_check_url", "profile_return_ok",
  "user_comment_text", "user_action_reason", "user_action_result", "dwell_seconds", "interest_score",
  "title", "caption", "author", "author_href", "aweme_id", "hashtags", "matched_keywords",
  "content_type", "duration_seconds", "current_position_seconds", "like_count", "comment_count", "share_count", "favorite_count",
  "before_url", "after_url", "scroll_delta", "transition_ok", "rpa_feedback", "raw_json",
] as const;

export function openDb(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec(`
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
      content_type TEXT,
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
    CREATE TABLE IF NOT EXISTS outbox (
      record_id TEXT PRIMARY KEY REFERENCES observations(observation_id),
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at REAL NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at REAL NOT NULL,
      sent_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_retry_at, created_at);
    CREATE TABLE IF NOT EXISTS quota_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      config_hash TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      record_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      payload TEXT NOT NULL,
      created_at REAL NOT NULL
    );
  `);
  const observationColumns = new Set(
    (db.query("PRAGMA table_info(observations)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!observationColumns.has("content_type")) {
    db.exec("ALTER TABLE observations ADD COLUMN content_type TEXT");
  }
  return db;
}

export function queueCounts(db: Database) {
  const row = db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('pending','failed') THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status IN ('pending','failed') AND json_extract(payload, '$.transition_ok') IS NULL THEN 1 ELSE 0 END), 0) AS transition_pending,
      COALESCE(SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END), 0) AS dead,
      COALESCE(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END), 0) AS sent
    FROM outbox
  `).get() as { pending: number; transition_pending: number; dead: number; sent: number };
  return {
    pending: Number(row.pending),
    transition_pending: Number(row.transition_pending),
    dead: Number(row.dead),
    sent: Number(row.sent),
  };
}

export function sessionCounts(db: Database, sessionId: string) {
  const row = db.query(
    "SELECT COUNT(*) AS observed, COALESCE(SUM(is_relevant),0) AS relevant FROM observations WHERE session_id=?",
  ).get(sessionId) as { observed: number; relevant: number };
  return { observed: Number(row.observed), relevant: Number(row.relevant) };
}
