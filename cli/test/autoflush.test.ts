import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireSyncLock,
  lastSyncAttemptMs,
  releaseSyncLock,
  selfCommand,
  shouldAutoFlush,
  syncLockPath,
  touchSyncAttempt,
} from "../src/autoflush.ts";
import { insertObservation, startSession } from "../src/collector.ts";
import { syncOutbox } from "../src/sync.ts";

function tempDb() {
  return path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-flush-")), "facts.sqlite");
}

test("shouldAutoFlush ignores empty queues and respects intervals", () => {
  const now = 1_000_000;
  expect(shouldAutoFlush(0, null, now)).toBe(false);
  expect(shouldAutoFlush(1, null, now)).toBe(true);
  expect(shouldAutoFlush(1, now - 5_000, now)).toBe(false);
  expect(shouldAutoFlush(1, now - 61_000, now)).toBe(true);
  // Large backlogs flush on the shorter interval.
  expect(shouldAutoFlush(50, now - 5_000, now)).toBe(false);
  expect(shouldAutoFlush(50, now - 16_000, now)).toBe(true);
});

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

test("sync attempts leave a readable last-attempt marker", () => {
  const db = tempDb();
  expect(lastSyncAttemptMs(db)).toBeNull();
  touchSyncAttempt(db);
  expect(typeof lastSyncAttemptMs(db)).toBe("number");
});

test("selfCommand keeps the source entry when running from a checkout", () => {
  const entry = process.argv[1] || "";
  const command = selfCommand(["sync", "--db", "x.sqlite"]);
  if (/\.(ts|mjs|js)$/.test(entry) && !entry.includes("$bunfs")) {
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toBe(entry);
    expect(command.slice(2)).toEqual(["sync", "--db", "x.sqlite"]);
  } else {
    expect(command).toEqual([process.execPath, "sync", "--db", "x.sqlite"]);
  }
});
