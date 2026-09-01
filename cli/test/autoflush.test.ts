import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireSyncLock,
  lastSyncAttemptMs,
  releaseSyncLock,
  syncLockPath,
  touchSyncAttempt,
} from "../src/autoflush.ts";
import { insertObservation, startSession } from "../src/collector.ts";
import { drainOutbox, syncOutbox } from "../src/sync.ts";

function tempDb() {
  return path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-flush-")), "facts.sqlite");
}

test("sync lock is exclusive, stale-breakable, and releasable", () => {
  const db = tempDb();
  expect(acquireSyncLock(db)).toBe(true);
  expect(acquireSyncLock(db)).toBe(false);
  releaseSyncLock(db);
  expect(acquireSyncLock(db)).toBe(true);
  // A crashed sync leaves an old lock behind; a later attempt breaks it.
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(syncLockPath(db), stale, stale);
  expect(acquireSyncLock(db)).toBe(true);
  releaseSyncLock(db);
});

test("syncOutbox reports locked instead of racing a concurrent sync", async () => {
  const db = tempDb();
  startSession(db, 5, "observed");
  insertObservation(db, { title: "t", is_relevant: false });
  expect(acquireSyncLock(db)).toBe(true);
  const result = await syncOutbox(db);
  expect(result.status).toBe("locked");
  releaseSyncLock(db);
});

test("drainOutbox can wait for an active sync lock at a lifecycle boundary", async () => {
  const db = tempDb();
  startSession(db, 5, "observed");
  expect(acquireSyncLock(db)).toBe(true);
  setTimeout(() => releaseSyncLock(db), 25);
  try {
    const result = await drainOutbox(db, { lockWaitMs: 250, lockRetryMs: 10 });
    expect(["idle", "login_required"]).toContain(result.status);
  } finally {
    releaseSyncLock(db);
  }
});

test("sync attempts leave a readable last-attempt marker", () => {
  const db = tempDb();
  expect(lastSyncAttemptMs(db)).toBeNull();
  touchSyncAttempt(db);
  expect(typeof lastSyncAttemptMs(db)).toBe("number");
});
