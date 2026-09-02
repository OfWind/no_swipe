import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// CONFIG_DIR is resolved at import time, so point it at an empty temp
// directory before loading the module under test.
process.env.NO_SWIPE_AUTH_DIR = mkdtempSync(path.join(tmpdir(), "no-swipe-up-auth-"));
const { up } = await import("../src/up.ts");

test("up reports auth_login with no credentials and stays offline-safe", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "no-swipe-up-data-"));
  const result = await up(dataDir);
  expect(result.ok).toBe(true);
  expect(result.auth.connected).toBe(false);
  expect(result.next).toBe("auth_login");
  expect(result.accounts).toEqual([]);
  expect(result.data_dir).toBe(dataDir);
  expect(result.legacy_workspace_data).toBeNull();
  expect(typeof result.workbench_url).toBe("string");
  expect(result.workbench_url.startsWith("https://")).toBe(true);
  expect(typeof result.plugin_version).toBe("string");
});

test("up tolerates a missing data dir without throwing", async () => {
  const result = await up(path.join(tmpdir(), "no-swipe-up-missing", "nested"));
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.accounts)).toBe(true);
});

test("up lists bound accounts slim with their recorded nickname", async () => {
  const { runConfig } = await import("../src/config_cmd.ts");
  const dataDir = mkdtempSync(path.join(tmpdir(), "no-swipe-up-bound-"));
  const preset = path.resolve(
    import.meta.dir,
    "../../plugins/no-swipe/config/presets/douyin-youth-white-collar.v1.json",
  );
  const drafts = path.join(dataDir, "drafts");
  await runConfig([
    "preset", "materialize", preset,
    "--account-ref", "douyin:test-777",
    "--profile-id", "profile-test-777",
    "--run-id", "run-1",
    "--output-dir", drafts,
  ]);
  await runConfig(["profile", "bind", path.join(drafts, "account-profile.json"), "--data-dir", dataDir]);
  await runConfig(["profile", "identity", "douyin:test-777", "--nickname", "Wind", "--data-dir", dataDir]);

  const result = await up(dataDir);
  expect(result.accounts.length).toBe(1);
  const account = result.accounts[0] as Record<string, unknown>;
  expect(account.account_ref).toBe("douyin:test-777");
  expect(account.douyin_nickname).toBe("Wind");
  expect(account.revision).toBe(1);
  // Slim startup shape: no persona internals in the up output.
  expect(account.positive_topics).toBeUndefined();
  expect(account.content_rules).toBeUndefined();
});

test("profile identity keeps the latest nickname and retains changed names for audit", async () => {
  const { runConfig } = await import("../src/config_cmd.ts");
  const dataDir = mkdtempSync(path.join(tmpdir(), "no-swipe-up-nickname-history-"));

  await runConfig(["profile", "identity", "douyin:test-rename", "--nickname", "旧昵称", "--data-dir", dataDir]);
  await runConfig(["profile", "identity", "douyin:test-rename", "--nickname", "新昵称", "--data-dir", dataDir]);

  const accountDirectories = readdirSync(path.join(dataDir, "accounts"));
  expect(accountDirectories).toHaveLength(1);
  const identityPath = path.join(dataDir, "accounts", accountDirectories[0], "identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  expect(identity.douyin_nickname).toBe("新昵称");
  expect(identity.nickname_history.map((entry: Record<string, unknown>) => entry.douyin_nickname)).toEqual(["旧昵称"]);
});

test("up reports pending outbox across every run sqlite, not only runs/current", async () => {
  const { insertObservation, startSession } = await import("../src/collector.ts");
  const dataDir = mkdtempSync(path.join(tmpdir(), "no-swipe-up-outbox-"));
  const first = path.join(dataDir, "runs", "run-a", "douyin_rpa_session.sqlite");
  const second = path.join(dataDir, "runs", "run-b", "facts.sqlite");
  startSession(first, 5, "observed");
  startSession(second, 5, "observed");
  insertObservation(first, { title: "a", is_relevant: false });
  insertObservation(second, { title: "b", is_relevant: false });
  insertObservation(second, { title: "c", is_relevant: false });

  const result = await up(dataDir);
  expect(result.outbox.pending).toBe(3);
  expect(result.outbox.databases).toBe(2);
  expect(result.outbox.flushed).toBe(false);
  expect(result.outboxes).toHaveLength(2);
  expect(result.feed.entry_plan.length).toBeGreaterThan(0);
  expect(result.feed.facts).toContain("douyin_page_facts.js");
});

test("up skips identity-only account directories instead of failing startup", async () => {
  const { runConfig } = await import("../src/config_cmd.ts");
  const dataDir = mkdtempSync(path.join(tmpdir(), "no-swipe-up-identity-"));
  await runConfig(["profile", "identity", "douyin:test-888", "--nickname", "小王", "--data-dir", dataDir]);
  const result = await up(dataDir);
  expect(result.ok).toBe(true);
  expect(result.accounts).toEqual([]);
});
