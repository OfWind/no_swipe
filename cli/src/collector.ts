import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { CSV_FIELDS, openDb, queueCounts, sessionCounts } from "./store.ts";

const BOOLEAN_FIELDS = new Set([
  "is_relevant", "profile_check_attempted", "profile_tag_hit", "profile_return_ok",
  "transition_ok", "user_commented", "user_favorited", "user_followed", "user_liked",
]);
const JSON_FIELDS = new Set(["hashtags", "matched_keywords", "profile_visible_labels", "rpa_feedback", "user_action_result"]);

function nowIso() {
  return new Date().toISOString();
}

function jsonValue(value: unknown, fallback: unknown) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function recordPayload(row: Record<string, unknown>) {
  const payload: Record<string, unknown> = { contract_version: 2, record_id: String(row.observation_id) };
  for (const [key, value] of Object.entries(row)) {
    if (["observation_id", "created_at", "raw_json", "record_hash"].includes(key)) continue;
    if (BOOLEAN_FIELDS.has(key)) payload[key] = value == null ? null : Boolean(value);
    else if (JSON_FIELDS.has(key)) payload[key] = jsonValue(value, key === "rpa_feedback" || key === "user_action_result" ? {} : []);
    else payload[key] = value;
  }
  payload.raw_browser_observation = jsonValue(row.raw_json, {});
  return payload;
}

function queueRecord(db: ReturnType<typeof openDb>, row: Record<string, unknown>) {
  const payload = recordPayload(row);
  db.query(`
    INSERT INTO outbox(record_id, session_id, payload, status, attempts, next_retry_at, created_at)
    VALUES (?, ?, ?, 'pending', 0, 0, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      payload=excluded.payload,
      status=CASE WHEN outbox.status='sent' THEN 'sent' ELSE 'pending' END,
      next_retry_at=CASE WHEN outbox.status='sent' THEN outbox.next_retry_at ELSE 0 END,
      last_error=CASE WHEN outbox.status='sent' THEN outbox.last_error ELSE NULL END
  `).run(payload.record_id, payload.session_id, JSON.stringify(payload), Date.now() / 1000);
}

export function activeSession(db: ReturnType<typeof openDb>) {
  return db.query("SELECT * FROM sessions WHERE status='active' ORDER BY started_epoch DESC LIMIT 1").get() as Record<string, unknown> | null;
}

export function startSession(dbPath: string, target: number, countMode: "relevant" | "observed", forceNew = false) {
  const db = openDb(dbPath);
  let session = forceNew ? null : activeSession(db);
  if (!session) {
    session = {
      session_id: randomUUID(),
      started_at: nowIso(),
      started_epoch: Date.now() / 1000,
      target_count: target,
      count_mode: countMode,
      status: "active",
    };
    db.query(`
      INSERT INTO sessions(session_id, started_at, started_epoch, target_count, count_mode, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(session.session_id, session.started_at, session.started_epoch, target, countMode);
  }
  const counts = sessionCounts(db, String(session.session_id));
  const progress = session.count_mode === "observed" ? counts.observed : counts.relevant;
  return {
    session_id: session.session_id,
    status: session.status,
    target: Number(session.target_count),
    count_mode: session.count_mode,
    ...counts,
    progress,
    started_at: session.started_at,
    upload: queueCounts(db),
  };
}

export function insertObservation(dbPath: string, data: Record<string, unknown>) {
  const db = openDb(dbPath);
  const session = activeSession(db);
  if (!session) throw new Error("no active session; run start first");
  const counts = sessionCounts(db, String(session.session_id));
  const isRelevant = data.is_relevant === true || data.is_relevant === 1;
  const row: Record<string, unknown> = {
    observation_id: data.observation_id || data.record_id || randomUUID(),
    session_id: session.session_id,
    observed_at: data.observed_at || nowIso(),
    elapsed_seconds: Number(data.elapsed_seconds ?? 0),
    feed_index: Number(data.feed_index || counts.observed + 1),
    target_index: isRelevant ? counts.relevant + 1 : null,
    is_relevant: isRelevant ? 1 : 0,
    decision: data.decision || (isRelevant ? "keep" : "skip"),
    action: data.action || (isRelevant ? "watch_then_next" : "skip"),
    user_liked: data.user_liked ? 1 : 0,
    user_favorited: data.user_favorited ? 1 : 0,
    user_commented: data.user_commented ? 1 : 0,
    user_followed: data.user_followed ? 1 : 0,
    profile_check_attempted: data.profile_check_attempted ?? null,
    profile_tag_hit: data.profile_tag_hit ?? null,
    profile_visible_labels: JSON.stringify(data.profile_visible_labels ?? []),
    profile_check_url: data.profile_check_url ?? "",
    profile_return_ok: data.profile_return_ok ?? null,
    user_comment_text: data.user_comment_text ?? "",
    user_action_reason: data.user_action_reason ?? "",
    user_action_result: JSON.stringify(data.user_action_result ?? {}),
    dwell_seconds: data.dwell_seconds ?? null,
    interest_score: data.interest_score ?? null,
    title: data.title ?? "",
    caption: data.caption ?? "",
    author: data.author ?? "",
    author_href: data.author_href ?? "",
    aweme_id: data.aweme_id ?? "",
    hashtags: JSON.stringify(data.hashtags ?? []),
    matched_keywords: JSON.stringify(data.matched_keywords ?? []),
    content_type: data.content_type ?? data.contentType ?? "",
    duration_seconds: data.duration_seconds ?? null,
    current_position_seconds: data.current_position_seconds ?? null,
    like_count: data.like_count ?? null,
    comment_count: data.comment_count ?? null,
    share_count: data.share_count ?? null,
    favorite_count: data.favorite_count ?? null,
    before_url: data.before_url ?? "",
    after_url: data.after_url ?? "",
    scroll_delta: data.scroll_delta ?? null,
    transition_ok: data.transition_ok == null ? null : Number(Boolean(data.transition_ok)),
    rpa_feedback: JSON.stringify(data.rpa_feedback ?? {}),
    raw_json: JSON.stringify(data),
    created_at: nowIso(),
  };
  const fields = [...CSV_FIELDS, "created_at"];
  const placeholders = fields.map(() => "?").join(",");
  const commit = db.transaction(() => {
    db.query(`INSERT INTO observations(${fields.join(",")}) VALUES (${placeholders})`).run(
      ...fields.map((field) => row[field]),
    );
    queueRecord(db, row);
  });
  commit();
  const next = sessionCounts(db, String(session.session_id));
  const progress = session.count_mode === "observed" ? next.observed : next.relevant;
  return {
    ok: true,
    observation_id: row.observation_id,
    session_id: session.session_id,
    feed_index: row.feed_index,
    target_index: row.target_index,
    ...next,
    target: Number(session.target_count),
    count_mode: session.count_mode,
    progress,
    completed: progress >= Number(session.target_count),
    upload: queueCounts(db),
  };
}

export function recordTransition(dbPath: string, data: Record<string, unknown>) {
  const db = openDb(dbPath);
  const recordId = String(data.record_id || data.observation_id || "").trim();
  if (!recordId) throw new Error("record_id is required");
  if (typeof data.transition_ok !== "boolean") throw new Error("transition_ok must be boolean");

  const update = db.transaction(() => {
    const row = db.query("SELECT * FROM observations WHERE observation_id=?").get(recordId) as Record<string, unknown> | null;
    if (!row) throw new Error(`observation not found: ${recordId}`);
    const queued = db.query("SELECT status FROM outbox WHERE record_id=?").get(recordId) as { status?: string } | null;
    if (!queued) throw new Error(`outbox record not found: ${recordId}`);
    if (queued.status === "sent") throw new Error(`transition result arrived after upload: ${recordId}`);

    const transitionOk = data.transition_ok;
    const scrollDelta = Number(data.scroll_delta ?? (transitionOk ? 1 : 0));
    const beforeUrl = String(data.before_url ?? row.before_url ?? "");
    const afterUrl = String(data.after_url ?? row.after_url ?? "");
    const transition = {
      ok: transitionOk,
      method: data.method == null ? null : String(data.method),
      reason: data.reason == null ? null : String(data.reason),
      from_aweme_id: String(data.from_aweme_id ?? row.aweme_id ?? ""),
      to_aweme_id: String(data.to_aweme_id ?? ""),
    };
    const feedback = jsonValue(row.rpa_feedback, {}) as Record<string, unknown>;
    const raw = jsonValue(row.raw_json, {}) as Record<string, unknown>;
    const nextFeedback = { ...feedback, transition };
    const nextRaw = {
      ...raw,
      before_url: beforeUrl,
      after_url: afterUrl,
      scroll_delta: scrollDelta,
      transition_ok: transitionOk,
      rpa_feedback: nextFeedback,
      transition,
    };

    db.query(`
      UPDATE observations
      SET before_url=?, after_url=?, scroll_delta=?, transition_ok=?, rpa_feedback=?, raw_json=?
      WHERE observation_id=?
    `).run(
      beforeUrl,
      afterUrl,
      scrollDelta,
      Number(transitionOk),
      JSON.stringify(nextFeedback),
      JSON.stringify(nextRaw),
      recordId,
    );
    const updated = db.query("SELECT * FROM observations WHERE observation_id=?").get(recordId) as Record<string, unknown>;
    const payload = JSON.stringify(recordPayload(updated));
    db.query(`
      UPDATE outbox
      SET payload=?,
          status=CASE WHEN status='failed' THEN 'pending' ELSE status END,
          next_retry_at=CASE WHEN status='failed' THEN 0 ELSE next_retry_at END,
          last_error=CASE WHEN status='failed' THEN NULL ELSE last_error END
      WHERE record_id=?
    `).run(payload, recordId);
  });
  update();
  return {
    ok: true,
    status: "transition_recorded",
    record_id: recordId,
    transition_ok: data.transition_ok,
    scroll_delta: Number(data.scroll_delta ?? (data.transition_ok ? 1 : 0)),
    upload: queueCounts(db),
  };
}

export function statusSession(dbPath: string) {
  const db = openDb(dbPath);
  const session = activeSession(db);
  if (!session) {
    const last = db.query("SELECT * FROM sessions ORDER BY started_epoch DESC LIMIT 1").get() as { status?: string } | null;
    return { status: last?.status ?? "none", upload: queueCounts(db) };
  }
  const counts = sessionCounts(db, String(session.session_id));
  const progress = session.count_mode === "observed" ? counts.observed : counts.relevant;
  return {
    session_id: session.session_id,
    status: session.status,
    target: Number(session.target_count),
    count_mode: session.count_mode,
    ...counts,
    progress,
    remaining: Math.max(0, Number(session.target_count) - progress),
    completed: progress >= Number(session.target_count),
    upload: queueCounts(db),
  };
}

export function finishSession(dbPath: string) {
  const db = openDb(dbPath);
  const session = activeSession(db);
  if (!session) throw new Error("no active session");
  const elapsed = Math.max(0, Date.now() / 1000 - Number(session.started_epoch));
  db.query("UPDATE sessions SET status='finished', finished_at=?, elapsed_seconds=? WHERE session_id=?")
    .run(nowIso(), elapsed, session.session_id);
  return { ok: true, session_id: session.session_id, elapsed_seconds: elapsed, upload: queueCounts(db) };
}

export function exportCsv(dbPath: string, csvPath: string, targetCsvPath: string) {
  const db = openDb(dbPath);
  const rows = db.query("SELECT * FROM observations ORDER BY created_at, feed_index").all() as Record<string, unknown>[];
  const write = (file: string, list: Record<string, unknown>[]) => {
    const header = CSV_FIELDS.join(",");
    const body = list.map((row) => CSV_FIELDS.map((field) => JSON.stringify(row[field] ?? "")).join(",")).join("\n");
    writeFileSync(file, `${header}\n${body}\n`);
  };
  write(csvPath, rows);
  write(targetCsvPath, rows.filter((row) => Number(row.is_relevant) === 1));
  return { ok: true, observed: rows.length, relevant: rows.filter((row) => Number(row.is_relevant) === 1).length, csv: csvPath, target_csv: targetCsvPath };
}
