import { functionUrl, loadCloudConfig } from "./cloud.ts";
import { readCredentials } from "./auth.ts";
import { openDb, queueCounts } from "./store.ts";

const MAX_REQUEST_BYTES = 400_000;
const MAX_ATTEMPTS = 8;

function retryDelay(attempt: number) {
  return Math.min(3600, 5 * (2 ** Math.max(0, attempt - 1))) * (0.75 + Math.random() * 0.5);
}

export async function syncOutbox(dbPath: string, { force = true, batchSize = 100 } = {}) {
  const db = openDb(dbPath);
  const credentials = readCredentials();
  if (!credentials?.device_token) return { status: "login_required", ...queueCounts(db) };
  const config = loadCloudConfig();
  const now = Date.now() / 1000;
  const due = db.query(`
    SELECT session_id, COUNT(*) AS due_count, MIN(created_at) AS oldest
    FROM outbox
    WHERE status IN ('pending','failed') AND next_retry_at<=?
    GROUP BY session_id
    ORDER BY oldest
  `).all(now) as Array<{ session_id: string; due_count: number; oldest: number }>;
  if (!due.length) return { status: "idle", ...queueCounts(db) };
  const selected = due.find((row) => force || row.due_count >= 10 || now - row.oldest >= 60) ?? (force ? due[0] : null);
  if (!selected) return { status: "deferred", ...queueCounts(db) };

  let rows = db.query(`
    SELECT * FROM outbox
    WHERE session_id=? AND status IN ('pending','failed') AND next_retry_at<=?
    ORDER BY created_at LIMIT ?
  `).all(selected.session_id, now, batchSize) as Array<Record<string, unknown>>;
  const session = db.query("SELECT * FROM sessions WHERE session_id=?").get(selected.session_id) as Record<string, unknown> | null;
  if (!session) return { status: "error", reason: "missing_session", ...queueCounts(db) };

  const encode = (list: Array<Record<string, unknown>>) => JSON.stringify({
    contract_version: 2,
    session_id: selected.session_id,
    client: { plugin_version: config.plugin_version, host_fingerprint: credentials.host_fingerprint },
    task_config: {},
    started_at: session.started_at,
    finished_at: session.finished_at ?? null,
    stats: {},
    heartbeat: { pending: queueCounts(db).pending },
    records: list.map((row) => JSON.parse(String(row.payload))),
  });
  while (rows.length > 1 && encode(rows).length > MAX_REQUEST_BYTES) rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
  const body = encode(rows);
  if (body.length > MAX_REQUEST_BYTES) {
    mark(db, rows, "record payload exceeds upload limit", true);
    return { status: "rejected", ...queueCounts(db) };
  }

  const response = await fetch(functionUrl(config, config.edge_function), {
    method: "POST",
    headers: {
      apikey: config.publishable_key,
      authorization: `Bearer ${credentials.device_token}`,
      "content-type": "application/json",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) return { status: "auth_error", reason: payload.error || "unauthorized", ...queueCounts(db) };
  if (!response.ok) {
    const permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
    mark(db, rows, String(payload.error || response.status), permanent);
    return { status: permanent ? "rejected" : "retry_scheduled", ...queueCounts(db) };
  }

  const accepted = new Set((payload.accepted ?? []).map(String));
  const duplicated = new Set((payload.duplicated ?? []).map(String));
  const rejected = new Map(
    (payload.rejected ?? []).filter((item: { id?: string }) => item?.id).map((item: { id: string; reason?: string }) => [item.id, item.reason || "rejected"]),
  );
  for (const row of rows) {
    const id = String(row.record_id);
    const attempts = Number(row.attempts) + 1;
    if (accepted.has(id) || duplicated.has(id)) {
      db.query("UPDATE outbox SET status='sent', attempts=?, sent_at=?, next_retry_at=0, last_error=NULL WHERE record_id=?")
        .run(attempts, Date.now() / 1000, id);
    } else if (rejected.has(id) || attempts >= MAX_ATTEMPTS) {
      db.query("UPDATE outbox SET status='dead', attempts=?, last_error=? WHERE record_id=?")
        .run(attempts, String(rejected.get(id) || "retry_exhausted").slice(0, 500), id);
    } else {
      db.query("UPDATE outbox SET status='failed', attempts=?, next_retry_at=?, last_error=? WHERE record_id=?")
        .run(attempts, Date.now() / 1000 + retryDelay(attempts), "missing acknowledgement", id);
    }
  }
  return {
    status: "ok",
    accepted: accepted.size,
    duplicated: duplicated.size,
    rejected: rejected.size,
    ...queueCounts(db),
  };
}

function mark(db: ReturnType<typeof openDb>, rows: Array<Record<string, unknown>>, message: string, permanent: boolean) {
  for (const row of rows) {
    const attempts = Number(row.attempts) + 1;
    db.query("UPDATE outbox SET status=?, attempts=?, next_retry_at=?, last_error=? WHERE record_id=?")
      .run(
        permanent || attempts >= MAX_ATTEMPTS ? "dead" : "failed",
        attempts,
        permanent ? 0 : Date.now() / 1000 + retryDelay(attempts),
        message.slice(0, 500),
        row.record_id,
      );
  }
}
