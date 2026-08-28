import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 2 * 60 * 1000;
const BACKLOG_BATCH = 25;
const BACKLOG_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MS = 60_000;

export function syncLockPath(dbPath: string) {
  return `${dbPath}.sync.lock`;
}

function lastAttemptPath(dbPath: string) {
  return `${dbPath}.sync.last`;
}

export function acquireSyncLock(dbPath: string, now = Date.now()): boolean {
  const file = syncLockPath(dbPath);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (now - statSync(file).mtimeMs > LOCK_STALE_MS) {
        rmSync(file, { force: true });
        writeFileSync(file, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      // Lock disappeared between the failed create and the stat; one skipped
      // flush is fine because the next commit re-evaluates the watermark.
    }
    return false;
  }
}

export function releaseSyncLock(dbPath: string) {
  rmSync(syncLockPath(dbPath), { force: true });
}

export function touchSyncAttempt(dbPath: string, now = Date.now()) {
  const file = lastAttemptPath(dbPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, new Date(now).toISOString());
}

export function lastSyncAttemptMs(dbPath: string): number | null {
  try {
    return statSync(lastAttemptPath(dbPath)).mtimeMs;
  } catch {
    return null;
  }
}

// A large backlog flushes eagerly; a trickle flushes once per idle interval.
// Both silently stand down while another sync holds the lock or just ran,
// so offline runs spawn at most one probe per interval.
export function shouldAutoFlush(pending: number, lastAttemptMs: number | null, now = Date.now()): boolean {
  if (!Number.isFinite(pending) || pending <= 0) return false;
  if (lastAttemptMs == null) return true;
  const interval = pending >= BACKLOG_BATCH ? BACKLOG_INTERVAL_MS : IDLE_INTERVAL_MS;
  return now - lastAttemptMs >= interval;
}

// From a source checkout argv[1] is a real script file; a compiled binary
// embeds a virtual /$bunfs entry and must be re-invoked directly.
export function selfCommand(args: string[]): string[] {
  const entry = process.argv[1] || "";
  const fromSource = entry !== ""
    && !entry.includes("$bunfs")
    && /\.(ts|mjs|js)$/.test(entry)
    && existsSync(entry);
  return fromSource ? [process.execPath, entry, ...args] : [process.execPath, ...args];
}

export function spawnDetachedSync(dbPath: string): number | null {
  try {
    const child = Bun.spawn({
      cmd: selfCommand(["sync", "--db", dbPath]),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

export function maybeAutoFlush(dbPath: string, pending: number, now = Date.now()): boolean {
  if (!shouldAutoFlush(pending, lastSyncAttemptMs(dbPath), now)) return false;
  return spawnDetachedSync(dbPath) != null;
}
