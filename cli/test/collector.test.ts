import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCloudConfig } from "../src/cloud.ts";
import { insertObservation, startSession, statusSession } from "../src/collector.ts";
import { runConfig } from "../src/config_cmd.ts";
import { runStep } from "../src/step.ts";

const profile = {
  selection_mode: "include",
  positive_topics: ["相机"],
  high_priority_topics: ["相机评测"],
  negative_topics: ["带货"],
  classification: { high_match_count: 2 },
};

test("cloud config works without a plugin checkout", () => {
  const previous = process.env.NO_SWIPE_SUPABASE_CONFIG;
  process.env.NO_SWIPE_SUPABASE_CONFIG = "/tmp/missing-no-swipe-supabase.json";
  const config = loadCloudConfig();
  expect(config.url).toContain("supabase.co");
  expect(config.publishable_key.startsWith("sb_")).toBe(true);
  if (previous === undefined) delete process.env.NO_SWIPE_SUPABASE_CONFIG;
  else process.env.NO_SWIPE_SUPABASE_CONFIG = previous;
});

test("config materialize reads plugin files via NO_SWIPE_PLUGIN_ROOT", async () => {
  const previous = process.env.NO_SWIPE_PLUGIN_ROOT;
  const pluginRoot = path.resolve(import.meta.dir, "../../plugins/no-swipe");
  const outputDir = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-cfg-")), "draft");
  process.env.NO_SWIPE_PLUGIN_ROOT = pluginRoot;
  const result = await runConfig([
    "preset",
    "materialize",
    path.join(pluginRoot, "config/presets/douyin-youth-white-collar.v1.json"),
    "--account-ref",
    "douyin:test",
    "--profile-id",
    "profile-test",
    "--run-id",
    "run-test",
    "--output-dir",
    outputDir,
  ]) as { ok: boolean; profile: string; run_config: string };
  expect(result.ok).toBe(true);
  expect(result.profile.endsWith("account-profile.json")).toBe(true);
  if (previous === undefined) delete process.env.NO_SWIPE_PLUGIN_ROOT;
  else process.env.NO_SWIPE_PLUGIN_ROOT = previous;
});

test("start, record and status use one sqlite file", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  const started = startSession(dbPath, 2, "relevant");
  expect(started.status).toBe("active");
  const recorded = insertObservation(dbPath, {
    is_relevant: true,
    decision: "keep",
    action: "watch_then_next",
    title: "相机评测",
  });
  expect(recorded.observed).toBe(1);
  expect(recorded.upload.pending).toBe(1);
  const status = statusSession(dbPath);
  expect(status.progress).toBe(1);
});

test("step skips live content without asking for evidence", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "relevant");
  const result = runStep({
    dbPath,
    runConfig: { run_id: "run-1", account_ref: "acc", interest_profile: profile },
    page: { title: "相机评测", caption: "相机", contentType: "live", duration_seconds: 20 },
  });
  expect(result.status).toBe("committed");
  expect(result.classification.relevant).toBe(true);
});

test("exclusion-only profiles treat watchable items as interaction-eligible high", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const excludeOnlyProfile = {
    selection_mode: "exclude_only",
    positive_topics: [],
    high_priority_topics: [],
    negative_topics: ["擦边"],
    content_rules: { minimum_like_count: 1000, below_minimum_behavior: "skip_unless_recent" },
    classification: { high_match_count: 2 },
  };
  const result = runStep({
    dbPath,
    runConfig: { run_id: "run-1", account_ref: "acc", interest_profile: excludeOnlyProfile },
    page: { title: "西藏自驾游记", like_count: 31000, duration_seconds: 300 },
  });
  expect(result.status).toBe("committed");
  expect(result.classification.high).toBe(true);
  expect(result.classification.level).toBe("high");

  const excludedResult = runStep({
    dbPath,
    runConfig: { run_id: "run-1", account_ref: "acc", interest_profile: excludeOnlyProfile },
    page: { title: "擦边视频", like_count: 31000, duration_seconds: 300 },
  });
  expect(excludedResult.classification.high).toBe(false);
  expect(excludedResult.classification.relevant).toBe(false);
});

test("step persists when evidence is explicitly null", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "relevant");
  const result = runStep({
    dbPath,
    runConfig: {
      run_id: "run-1",
      account_ref: "acc",
      interest_profile: {
        ...profile,
        creator_rules: { high_relevance: { follower_count_min: 1000, follower_count_max: 100000, require_stable_recent_likes: true } },
      },
    },
    record_id: "rec-null",
    page: { title: "相机评测", caption: "相机", duration_seconds: 20, like_count: 10 },
    evidence: { creatorFollowerCount: null, creatorRecentLikesStable: null, isRecentlyPublished: null },
  });
  expect(result.status).toBe("committed");
  expect(result.record_id).toBe("rec-null");
});

test("step asks for evidence then commits", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "relevant");
  const runConfig = {
    run_id: "run-1",
    account_ref: "acc",
    interest_profile: {
      ...profile,
      creator_rules: { high_relevance: { follower_count_min: 1000, follower_count_max: 100000, require_stable_recent_likes: true } },
    },
  };
  const first = runStep({
    dbPath,
    runConfig,
    page: { title: "相机评测", caption: "相机", author: "a", duration_seconds: 20, like_count: 10 },
  });
  expect(first.status).toBe("needs_evidence");
  const second = runStep({
    dbPath,
    runConfig,
    record_id: first.record_id,
    page: { title: "相机评测", caption: "相机", author: "a", duration_seconds: 20, like_count: 10 },
    evidence: { creatorFollowerCount: 5000, creatorRecentLikesStable: true, isRecentlyPublished: false },
  });
  expect(second.status).toBe("committed");
  expect(second.upload.pending).toBe(1);
});

test("start CLI defaults to 1000 observed videos", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  const proc = Bun.spawnSync(["bun", "src/main.ts", "start", "--db", dbPath], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  expect(proc.exitCode).toBe(0);
  const started = JSON.parse(new TextDecoder().decode(proc.stdout));
  expect(started.count_mode).toBe("observed");
  expect(started.target).toBe(1000);
});

test("materialize preserves revision from profile-input and rejects a bad --revision", async () => {
  const previous = process.env.NO_SWIPE_PLUGIN_ROOT;
  const pluginRoot = path.resolve(import.meta.dir, "../../plugins/no-swipe");
  const dir = mkdtempSync(path.join(tmpdir(), "no-swipe-rev-"));
  process.env.NO_SWIPE_PLUGIN_ROOT = pluginRoot;
  const first = await runConfig([
    "preset",
    "materialize",
    path.join(pluginRoot, "config/presets/douyin-youth-white-collar.v1.json"),
    "--account-ref",
    "douyin:test",
    "--profile-id",
    "profile-test",
    "--run-id",
    "run-base",
  ]) as { profile: { revision: number; created_at: string } };
  first.profile.revision = 2;
  const inputPath = path.join(dir, "current.json");
  writeFileSync(inputPath, `${JSON.stringify(first.profile)}\n`);
  const second = await runConfig([
    "preset",
    "materialize",
    path.join(pluginRoot, "config/presets/douyin-youth-white-collar.v1.json"),
    "--account-ref",
    "douyin:test",
    "--profile-id",
    "profile-test",
    "--run-id",
    "run-next",
    "--profile-mode",
    "replace",
    "--profile-input",
    inputPath,
  ]) as { profile: { revision: number; created_at: string } };
  expect(second.profile.revision).toBe(2);
  expect(second.profile.created_at).toBe(first.profile.created_at);
  await expect(runConfig([
    "preset",
    "materialize",
    path.join(pluginRoot, "config/presets/douyin-youth-white-collar.v1.json"),
    "--account-ref",
    "douyin:test",
    "--profile-id",
    "profile-test",
    "--run-id",
    "run-bad",
    "--revision",
    "nope",
  ])).rejects.toThrow("revision must be a positive integer");
  if (previous === undefined) delete process.env.NO_SWIPE_PLUGIN_ROOT;
  else process.env.NO_SWIPE_PLUGIN_ROOT = previous;
});
