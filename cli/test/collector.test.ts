import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCloudConfig } from "../src/cloud.ts";
import { insertObservation, recordTransition, startSession, statusSession } from "../src/collector.ts";
import { runConfig } from "../src/config_cmd.ts";
import { runStep } from "../src/step.ts";
import { openDb } from "../src/store.ts";
import { confirmRunConfig, createProfileSnapshot } from "../src/config.mjs";

const pluginFixture = (relative: string) => path.join(import.meta.dir, "../../plugins/no-swipe", relative);
const draftFixture = () => JSON.parse(readFileSync(pluginFixture("tests/fixtures/run-config.draft.example.json"), "utf8"));
const profileFixture = () => JSON.parse(readFileSync(pluginFixture("tests/fixtures/account-profile.example.json"), "utf8"));

// step only accepts sealed configs; confirmRunConfig recomputes the hashes
// after the per-test profile and rate tweaks.
const zeroRates = [
  { eligible_relevance: ["high"], like_rate: 0, favorite_rate: 0, like_favorite_overlap_rate: 0, comment_rate: 0, completion_rate: 0, block_size: 20 },
  { eligible_relevance: ["medium"], like_rate: 0, favorite_rate: 0, like_favorite_overlap_rate: 0, comment_rate: 0, completion_rate: 0, block_size: 20 },
];
const sealedRunConfig = (profileOverrides: Record<string, unknown> = {}, rules = zeroRates) => {
  const draft = draftFixture();
  draft.interest_profile = createProfileSnapshot({ ...profileFixture(), content_rules: undefined, creator_rules: undefined, ...profileOverrides });
  draft.interaction_policy.rules = rules;
  return confirmRunConfig(draft, { confirmedBy: "user" });
};

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

test("an observation stays transition-pending until the runner records the verified result", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-transition-")), "facts.sqlite");
  startSession(dbPath, 2, "observed");
  const recorded = insertObservation(dbPath, {
    observation_id: "transition-1",
    aweme_id: "aweme-1",
    is_relevant: false,
  });
  const db = openDb(dbPath);
  const before = db.query("SELECT scroll_delta, transition_ok FROM observations WHERE observation_id=?")
    .get(recorded.observation_id) as { scroll_delta: number | null; transition_ok: number | null };
  const queuedBefore = JSON.parse(String((db.query("SELECT payload FROM outbox WHERE record_id=?")
    .get(recorded.observation_id) as { payload: string }).payload));
  expect(before.scroll_delta).toBeNull();
  expect(before.transition_ok).toBeNull();
  expect(queuedBefore.scroll_delta).toBeNull();
  expect(queuedBefore.transition_ok).toBeNull();
  expect(recorded.upload.transition_pending).toBe(1);

  const updated = recordTransition(dbPath, {
    record_id: recorded.observation_id,
    transition_ok: true,
    scroll_delta: 1,
    method: "ARROWDOWN_SETTLED",
    from_aweme_id: "aweme-1",
    to_aweme_id: "aweme-2",
    before_url: "https://www.douyin.com/video/aweme-1",
    after_url: "https://www.douyin.com/video/aweme-2",
  });
  expect(updated.status).toBe("transition_recorded");

  const after = db.query("SELECT scroll_delta, transition_ok, rpa_feedback, raw_json FROM observations WHERE observation_id=?")
    .get(recorded.observation_id) as { scroll_delta: number; transition_ok: number; rpa_feedback: string; raw_json: string };
  const queuedAfter = JSON.parse(String((db.query("SELECT payload FROM outbox WHERE record_id=?")
    .get(recorded.observation_id) as { payload: string }).payload));
  expect(after.scroll_delta).toBe(1);
  expect(after.transition_ok).toBe(1);
  expect(JSON.parse(after.rpa_feedback).transition.method).toBe("ARROWDOWN_SETTLED");
  expect(JSON.parse(after.raw_json).transition_ok).toBe(true);
  expect(queuedAfter.transition_ok).toBe(true);
  expect(queuedAfter.rpa_feedback.transition.to_aweme_id).toBe("aweme-2");
  expect(queuedAfter.raw_browser_observation.transition_ok).toBe(true);
  expect(updated.upload.transition_pending).toBe(0);
});

test("transition CLI finalizes the same SQLite and outbox payload used by the runner", async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-transition-cli-")), "facts.sqlite");
  startSession(dbPath, 1, "observed");
  insertObservation(dbPath, { observation_id: "transition-cli-1", aweme_id: "aweme-1", is_relevant: false });
  const proc = Bun.spawn([process.execPath, "src/main.ts", "transition", "--db", dbPath], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({
    record_id: "transition-cli-1",
    transition_ok: false,
    scroll_delta: 0,
    reason: "feed_transition_unverified",
    from_aweme_id: "aweme-1",
    to_aweme_id: "aweme-1",
  }));
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  const result = JSON.parse(await new Response(proc.stdout).text());
  expect(result.status).toBe("transition_recorded");
  expect(result.transition_ok).toBe(false);
  expect(result.upload.transition_pending).toBe(0);
});

test("step skips live content without asking for evidence", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "relevant");
  const result = runStep({
    dbPath,
    runConfig: sealedRunConfig({ selection_mode: "include", positive_topics: ["相机"], high_priority_topics: ["相机评测"], negative_topics: ["带货"], classification: { high_match_count: 2 } }),
    page: { title: "相机评测", caption: "相机", contentType: "live", duration_seconds: 20 },
  });
  expect(result.status).toBe("committed");
  expect(result.classification.relevant).toBe(true);
});

test("step commits image-text posts as zero-dwell direct skips with persisted content type", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-image-text-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const result = runStep({
    dbPath,
    runConfig: sealedRunConfig({
      selection_mode: "exclude_only",
      positive_topics: [],
      high_priority_topics: [],
      negative_topics: ["擦边"],
      content_rules: {
        short_video_max_duration_seconds: 60,
        short_video_behavior: "not_interested_or_skip",
        minimum_like_count: 1000,
        below_minimum_behavior: "skip_unless_recent",
        recent_evidence_sources: ["feed_published_at"],
        recent_definition: "以推荐流可见发布时间为准",
      },
      classification: { high_match_count: 2 },
    }),
    page: {
      aweme_id: "image-text-1",
      title: "城市周末相册",
      content_type: "image_text",
      gallery_image_count: 8,
      duration_seconds: null,
      like_count: 5000,
    },
  });

  expect(result.status).toBe("committed");
  expect(result.classification.imagePost).toBe(true);
  expect(result.classification.directSkip).toBe(true);
  expect(result.relevance).toBe("none");
  expect(result.dwell_seconds).toBe(0);
  expect(result.planned_actions.not_interested).toBe(false);
  const row = openDb(dbPath).query(
    "SELECT content_type, action, dwell_seconds, rpa_feedback FROM observations WHERE observation_id=?",
  ).get(result.record_id) as { content_type: string; action: string; dwell_seconds: number; rpa_feedback: string };
  expect(row.content_type).toBe("image_text");
  expect(row.action).toBe("direct_skip");
  expect(row.dwell_seconds).toBe(0);
  expect(JSON.parse(row.rpa_feedback).content_type).toBe("image_text");
});

test("step plans one immediate not-interested action for an authorized image-text post", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-image-action-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const draft = draftFixture();
  draft.interest_profile = createProfileSnapshot({
    ...profileFixture(),
    selection_mode: "exclude_only",
    positive_topics: [],
    high_priority_topics: [],
    negative_topics: ["擦边"],
    creator_rules: undefined,
  });
  draft.interaction_policy.rules = zeroRates;
  draft.interaction_policy.not_interested = { rate: 1, max_total: 5, block_size: 20 };
  draft.authorization.not_interested = true;
  const runConfig = confirmRunConfig(draft, { confirmedBy: "user" });
  const page = {
    aweme_id: "7677131709351070992",
    title: "城市周末相册",
    content_type: "image_text",
    gallery_image_count: 8,
    duration_seconds: null,
    like_count: 5000,
  };

  const planned = runStep({ dbPath, runConfig, page });
  expect(planned.status).toBe("planned");
  expect(planned.dwell_seconds).toBe(0);
  expect(planned.planned_actions.not_interested).toBe(true);
  expect(planned.execution_plan.some((operation: { id?: string }) => operation.id === "dwell")).toBe(false);
  expect(planned.execution_plan.find((operation: { id?: string }) => operation.id === "not_interested_menu")?.locator.selector)
    .toBe(".video_7677131709351070992");

  const committed = runStep({
    dbPath,
    runConfig,
    page,
    record_id: planned.record_id,
    action_results: { not_interested: { attempted: true, success: true }, dwell_seconds: 0 },
  });
  expect(committed.status).toBe("committed");
  const row = openDb(dbPath).query("SELECT action FROM observations WHERE observation_id=?")
    .get(planned.record_id) as { action: string };
  expect(row.action).toBe("not_interested");
});

test("exclusion-only profiles treat watchable items as interaction-eligible high", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const excludeOnly = sealedRunConfig({
    selection_mode: "exclude_only",
    positive_topics: [],
    high_priority_topics: [],
    negative_topics: ["擦边"],
    content_rules: { minimum_like_count: 1000, below_minimum_behavior: "skip_unless_recent", recent_evidence_sources: ["feed_published_at"], recent_definition: "以推荐流可见发布时间为准" },
    classification: { high_match_count: 2 },
  });
  const result = runStep({
    dbPath,
    runConfig: excludeOnly,
    page: { title: "西藏自驾游记", like_count: 31000, duration_seconds: 300 },
  });
  expect(result.status).toBe("committed");
  expect(result.classification.high).toBe(true);
  expect(result.classification.level).toBe("high");

  const excludedResult = runStep({
    dbPath,
    runConfig: excludeOnly,
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
    runConfig: sealedRunConfig({ selection_mode: "include", positive_topics: ["相机"], high_priority_topics: ["相机评测"], negative_topics: ["带货"], classification: { high_match_count: 2 }, creator_rules: { high_relevance: { follower_count_min: 1000, follower_count_max: 100000, require_stable_recent_likes: true, stability_definition: "近10条作品点赞稳定", evidence_source: "recommendation_feed" } } }),
    record_id: "rec-null",
    page: { title: "相机评测", caption: "相机", duration_seconds: 20, like_count: 10 },
    evidence: { creatorFollowerCount: null, creatorRecentLikesStable: null, isRecentlyPublished: null },
  });
  expect(result.status).toBe("committed");
  expect(result.record_id).toBe("rec-null");
});

test("step rejects an aweme id already observed earlier in the active session", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-duplicate-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const runConfig = sealedRunConfig();

  const first = runStep({
    dbPath,
    runConfig,
    page: { aweme_id: "duplicate-a", title: "first", duration_seconds: 120, like_count: 5000 },
  });
  const second = runStep({
    dbPath,
    runConfig,
    page: { aweme_id: "duplicate-b", title: "second", duration_seconds: 120, like_count: 5000 },
  });
  const repeated = runStep({
    dbPath,
    runConfig,
    page: { aweme_id: "duplicate-a", title: "first again", duration_seconds: 120, like_count: 5000 },
  });

  expect(first.status).toBe("committed");
  expect(second.status).toBe("committed");
  expect(repeated.status).toBe("duplicate_page");
  expect(repeated.advance_plan[0].keys).toEqual(["ARROWDOWN"]);
  const count = openDb(dbPath).query("SELECT COUNT(*) AS count FROM observations").get() as { count: number };
  expect(count.count).toBe(2);
});

test("step asks for evidence then commits", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "relevant");
  const runConfig = sealedRunConfig({ selection_mode: "include", positive_topics: ["相机"], high_priority_topics: ["相机评测"], negative_topics: ["带货"], classification: { high_match_count: 2 }, creator_rules: { high_relevance: { follower_count_min: 1000, follower_count_max: 100000, require_stable_recent_likes: true, stability_definition: "近10条作品点赞稳定", evidence_source: "recommendation_feed" } } });
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

test("step plans in-quota interactions, then commits the executed action_results", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const runConfig = sealedRunConfig(
    { selection_mode: "include", positive_topics: ["相机"], high_priority_topics: ["相机评测"], negative_topics: ["带货"], classification: { high_match_count: 2 } },
    [{ eligible_relevance: ["high"], like_rate: 1, favorite_rate: 0, like_favorite_overlap_rate: 0, comment_rate: 0, completion_rate: 0, block_size: 20 }],
  );
  const page = { title: "相机评测", caption: "相机", author: "a", duration_seconds: 20, like_count: 10 };
  const first = runStep({ dbPath, runConfig, page });
  expect(first.status).toBe("planned");
  expect(first.planned_actions.like).toBe(true);
  expect(first.planned_actions.next).toBe(true);
  expect(typeof first.dwell_seconds).toBe("number");
  expect(first.execution_plan.some((op: { result_key?: string }) => op.result_key === "like")).toBe(true);
  expect(first.advance_plan[0].keys).toEqual(["ARROWDOWN"]);

  const second = runStep({
    dbPath,
    runConfig,
    record_id: first.record_id,
    page,
    action_results: { like: { attempted: true, success: true }, dwell_seconds: first.dwell_seconds },
  });
  expect(second.status).toBe("committed");
  expect(second.upload.pending).toBe(1);
});

test("step refuses to record when the page reports a stop signal", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  startSession(dbPath, 5, "relevant");
  const result = runStep({
    dbPath,
    runConfig: sealedRunConfig(),
    page: { title: "相机评测", caption: "相机", stop_text_hit: "验证码" },
  });
  expect(result.status).toBe("stop_required");
  expect(result.reason).toBe("验证码");
});

test("start CLI defaults to 1000 observed videos", () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-")), "facts.sqlite");
  const proc = Bun.spawnSync([process.execPath, "src/main.ts", "start", "--db", dbPath], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  expect(proc.exitCode).toBe(0);
  const started = JSON.parse(new TextDecoder().decode(proc.stdout));
  expect(started.count_mode).toBe("observed");
  expect(started.target).toBe(1000);
});

test("step CLI commits locally without waiting for one HTTP sync per observation", async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-step-cli-")), "facts.sqlite");
  startSession(dbPath, 5, "observed");
  const payload = {
    runConfig: sealedRunConfig(),
    page: { aweme_id: "step-local-1", title: "普通记录", duration_seconds: 120, like_count: 5000 },
  };
  const proc = Bun.spawn([process.execPath, "src/main.ts", "step", "--db", dbPath], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  const result = JSON.parse(await new Response(proc.stdout).text());
  expect(result.status).toBe("committed");
  expect(result.upload.pending).toBe(1);
  expect(result.sync).toBeUndefined();
});

test("finish keeps the session active and exits nonzero while upload is incomplete", async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "no-swipe-finish-cli-")), "facts.sqlite");
  const authDir = mkdtempSync(path.join(tmpdir(), "no-swipe-finish-auth-"));
  startSession(dbPath, 1, "observed");
  insertObservation(dbPath, { aweme_id: "finish-1", title: "pending", is_relevant: false });

  const proc = Bun.spawn([process.execPath, "src/main.ts", "finish", "--db", dbPath], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, NO_SWIPE_AUTH_DIR: authDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const result = JSON.parse(await new Response(proc.stdout).text());

  expect(exitCode).not.toBe(0);
  expect(result.status).toBe("upload_incomplete");
  expect(result.upload.pending).toBe(1);
  expect(statusSession(dbPath).status).toBe("active");
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
