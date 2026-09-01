import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { lastSyncAttemptMs } from "./autoflush.ts";
import { openDb, queueCounts } from "./store.ts";
import { drainOutbox } from "./sync.ts";

export function listRunDatabases(dataDir: string): string[] {
  const root = path.join(path.resolve(dataDir), "runs");
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(".sqlite")) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

export function snapshotOutboxes(dataDir: string) {
  return listRunDatabases(dataDir).map((db) => {
    const counts = queueCounts(openDb(db));
    return {
      db,
      ...counts,
      last_attempt_ms: lastSyncAttemptMs(db),
    };
  });
}

export async function flushPendingOutboxes(dataDir: string, connected: boolean) {
  const snapshots = snapshotOutboxes(dataDir);
  const results = [];
  for (const snap of snapshots) {
    if (!connected || snap.pending <= 0) {
      results.push({ ...snap, flushed: false, sync: null as Record<string, unknown> | null });
      continue;
    }
    const sync = await drainOutbox(snap.db);
    results.push({
      db: snap.db,
      ...queueCounts(openDb(snap.db)),
      last_attempt_ms: lastSyncAttemptMs(snap.db),
      flushed: true,
      sync,
    });
  }
  return results;
}

export function summarizeOutboxes(rows: Array<{ pending: number; dead: number; sent?: number; flushed?: boolean }>) {
  return {
    pending: rows.reduce((sum, row) => sum + Number(row.pending || 0), 0),
    dead: rows.reduce((sum, row) => sum + Number(row.dead || 0), 0),
    sent: rows.reduce((sum, row) => sum + Number(row.sent || 0), 0),
    databases: rows.length,
    flushed: rows.some((row) => row.flushed === true),
  };
}
