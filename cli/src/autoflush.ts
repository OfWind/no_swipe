import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 2 * 60 * 1000;

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
