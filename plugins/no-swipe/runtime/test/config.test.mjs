import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConfigValidationError,
  bindAccountProfile,
  confirmRunConfig,
  createProfileSnapshot,
  listAccountProfiles,
  materializeOnboardingPreset,
  quotaConfigFromRunConfig,
  resolveAccountProfile,
  updateAccountProfile,
  validateAccountProfile,
  validateOnboardingPreset,
  validateRunConfig,
} from "../src/config.mjs";
import {
  createDouyinRunner,
  restoreRunnerStateFromObservations,
  restoreRunnerStateFromQueue,
  selectAuthorProfileHref,
} from "../../skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs";
import { createCollectorClient } from "../../skills/douyin-recommendation-rpa/scripts/collector_client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = async (relative) => JSON.parse(await fs.readFile(path.join(ROOT, relative), "utf8"));

test("account profile produces a stable immutable snapshot", async () => {
  const profile = await read("tests/fixtures/account-profile.example.json");
  assert.equal(validateAccountProfile(profile), profile);
  const first = createProfileSnapshot(profile);
  const second = createProfileSnapshot({ ...profile, updated_at: "2026-08-14T00:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.match(first.profile_hash, /^sha256:[a-f0-9]{64}$/);
});

test("onboarding preset materializes one compact confirmed-ready decision", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  assert.equal(validateOnboardingPreset(preset), preset);
  const result = materializeOnboardingPreset(preset, {
    accountRef: "douyin:82338116099",
    profileId: "profile-82338116099",
    runId: "run-preset-test",
    timestamp: "2026-08-13T08:00:00.000Z",
  });
  assert.equal(result.profile.selection_mode, "exclude_only");
  assert.deepEqual(result.profile.positive_topics, []);
  assert.equal(result.profile.content_rules.short_video_max_duration_seconds, 60);
  assert.equal(result.profile.content_rules.short_video_behavior, "not_interested_or_skip");
  assert.equal(result.run_config.interaction_policy.rules[0].like_rate, 0.1);
  assert.equal(result.run_config.interaction_policy.follow.rate, 0.03);
  assert.equal(result.run_config.interaction_policy.rules[0].comment_rate, 0);
  assert.ok(Object.values(result.run_config.authorization).every(Boolean));
  assert.equal(validateRunConfig(result.run_config), result.run_config);
});

test("clear partial input extends the preset without concatenating arrays", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  const result = materializeOnboardingPreset(preset, {
    accountRef: "douyin:82338116099",
    profileId: "profile-82338116099",
    runId: "run-extend-test",
    timestamp: "2026-08-13T08:00:00.000Z",
    profileMode: "extend",
    profileInput: { negative_topics: ["营销号"] },
    runMode: "extend",
    runInput: { goal: { observed_target: 300 } },
  });
  assert.deepEqual(result.application, { profile_mode: "extend", run_mode: "extend" });
  assert.deepEqual(result.profile.negative_topics, ["营销号"]);
  assert.equal(result.run_config.goal.observed_target, 300);
  assert.equal(result.run_config.interaction_policy.rules[0].like_rate, 0.1);
});

test("replace mode has zero preset influence in the replaced scope", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  const replacement = {
    name: "摄影器材",
    selection_mode: "include",
    audience: ["摄影爱好者"],
    positive_topics: ["相机", "镜头"],
    high_priority_topics: ["相机评测"],
    negative_topics: ["婚庆接单"],
    excluded_creator_types: [],
    boundary_guidance: ["只看器材和创作方法。"],
    classification: { high_match_count: 1 },
  };
  const result = materializeOnboardingPreset(preset, {
    accountRef: "douyin:82338116099",
    profileId: "profile-82338116099",
    runId: "run-replace-test",
    timestamp: "2026-08-13T08:00:00.000Z",
    profileMode: "replace",
    profileInput: replacement,
  });
  assert.deepEqual(result.application, { profile_mode: "replace", run_mode: "preset" });
  assert.deepEqual(result.profile.negative_topics, ["婚庆接单"]);
  assert.equal(result.profile.creator_rules, undefined);
  assert.equal(result.profile.content_rules, undefined);
  assert.equal(result.run_config.goal.observed_target, 100);
});

test("replace mode rejects an omitted replacement object", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  assert.throws(
    () => materializeOnboardingPreset(preset, {
      accountRef: "douyin:82338116099",
      profileId: "profile-82338116099",
      runId: "run-invalid-replace",
      profileMode: "replace",
    }),
    /profile mode=replace/,
  );
});

test("short-video duration and behavior must be configured together", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  delete preset.profile.content_rules.short_video_behavior;
  assert.throws(() => validateOnboardingPreset(preset), ConfigValidationError);
});

test("product defaults expose all permissions but still require confirmation", async () => {
  const defaults = await read("config/defaults/safe-runtime.json");
  assert.ok(Object.values(defaults.authorization_defaults).every(Boolean));
  assert.equal(defaults.require_confirmed_config, true);
});

test("one No Swipe user keeps multiple Douyin account files while each account reuses one logical profile", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-profile-registry-"));
  try {
    const profile = await read("tests/fixtures/account-profile.example.json");
    await bindAccountProfile(profile, { dataDir });
    const secondProfile = {
      ...profile,
      profile_id: "profile-photography-b",
      account_ref: "douyin:local:account-b",
      name: "摄影账号 B",
    };
    await bindAccountProfile(secondProfile, { dataDir });
    assert.deepEqual(await resolveAccountProfile(profile.account_ref, { dataDir }), profile);
    assert.deepEqual(await resolveAccountProfile(secondProfile.account_ref, { dataDir }), secondProfile);
    assert.deepEqual(
      (await listAccountProfiles({ dataDir })).map((item) => item.account_ref),
      ["douyin:local:account-a", "douyin:local:account-b"],
    );
    assert.equal((await fs.readdir(path.join(dataDir, "accounts"))).length, 2);
    await assert.rejects(bindAccountProfile(profile, { dataDir }), /已绑定画像/);

    const revision2 = {
      ...profile,
      revision: 2,
      positive_topics: [...profile.positive_topics, "暗房"],
      updated_at: "2026-08-14T00:00:00.000Z",
    };
    await updateAccountProfile(revision2, { dataDir });
    assert.equal((await resolveAccountProfile(profile.account_ref, { dataDir })).revision, 2);
    assert.equal((await resolveAccountProfile(secondProfile.account_ref, { dataDir })).revision, 1);

    const accountARevision = (await Promise.all(
      (await fs.readdir(path.join(dataDir, "accounts"))).map(async (directory) => {
        const revisionPath = path.join(dataDir, "accounts", directory, "revisions/1.json");
        const candidate = JSON.parse(await fs.readFile(revisionPath, "utf8"));
        return candidate.account_ref === profile.account_ref ? candidate : null;
      }),
    )).find(Boolean);
    assert.ok(accountARevision);
    assert.equal(accountARevision.revision, 1);
    assert.equal(await resolveAccountProfile("douyin:local:other", { dataDir }), null);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("explicit zero rates are valid and missing rates are not", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  assert.equal(validateRunConfig(draft), draft);
  const missing = structuredClone(draft);
  delete missing.interaction_policy.rules[0].comment_rate;
  assert.throws(() => validateRunConfig(missing), ConfigValidationError);
});

test("positive state-changing rates require matching authorization", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  draft.authorization.like = false;
  assert.throws(
    () => validateRunConfig(draft),
    (error) => error instanceof ConfigValidationError
      && error.issues.some((issue) => issue.path === "$.authorization.like"),
  );
});

test("an explicit all-zero observation run can be confirmed", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  for (const rule of draft.interaction_policy.rules) {
    for (const key of ["like_rate", "favorite_rate", "like_favorite_overlap_rate", "comment_rate", "completion_rate"]) rule[key] = 0;
  }
  for (const key of Object.keys(draft.authorization)) draft.authorization[key] = false;
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  assert.equal(validateRunConfig(confirmed, { requireConfirmed: true }), confirmed);
});

test("overlap cannot exceed either component rate", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  draft.interaction_policy.rules[0].like_favorite_overlap_rate = 0.25;
  assert.throws(() => validateRunConfig(draft), ConfigValidationError);
});

test("confirmation seals the exact config and detects later changes", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(validateRunConfig(confirmed, { requireConfirmed: true }), confirmed);
  confirmed.goal.observed_target += 1;
  assert.throws(() => validateRunConfig(confirmed, { requireConfirmed: true }), ConfigValidationError);
});

test("run config maps to quota buckets without product-profile defaults", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  const quota = quotaConfigFromRunConfig(confirmed);
  assert.deepEqual(quota.highInteraction.rates, {
    like_only: 0.2,
    favorite_only: 0.1,
    like_and_favorite: 0.1,
    none: 0.6,
  });
  assert.equal(quota.follow.rates.candidate, 0);
  assert.equal(quota.notInterested.rates.apply, 0);
  assert.equal(quota.runConfigHash, confirmed.config_hash);
});

test("runner rejects an active account mismatch before browser access", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  await assert.rejects(
    createDouyinRunner({ tab: {}, runConfig: confirmed, activeAccountRef: "douyin:local:other" }),
    /账号.*不一致/,
  );
});

test("creator-evidence presets require a homepage evidence resolver", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  const { run_config: draft } = materializeOnboardingPreset(preset, {
    accountRef: "douyin:82338116099",
    profileId: "profile-82338116099",
    runId: "run-evidence-gate",
    timestamp: "2026-08-13T08:00:00.000Z",
  });
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:01:00.000Z",
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-evidence-gate-"));
  try {
    await assert.rejects(
      createDouyinRunner({
        tab: {},
        runConfig: confirmed,
        activeAccountRef: confirmed.account_ref,
        outputDir: directory,
        quotaPath: path.join(directory, "quota.json"),
        queuePath: path.join(directory, "queue.jsonl"),
      }),
      /resolveProfileEvidence/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("author profile lookup is not limited to the upper right sidebar", () => {
  const links = [
    { href: "/hashtag/camera", text: "#相机", y: 100 },
    { href: "/user/MS4wLjABAAAAcreator", text: "@摄影师阿北", y: 920 },
  ];
  assert.equal(
    selectAuthorProfileHref(links, "摄影师阿北"),
    "/user/MS4wLjABAAAAcreator",
  );
});

test("runner restores action caps and creator counts from the durable queue", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-runner-state-"));
  const queuePath = path.join(directory, "queue.jsonl");
  try {
    const row = {
      run_id: confirmed.run_id,
      config_hash: confirmed.config_hash,
      author: "creator-a",
      action: "not_interested",
      user_commented: true,
      user_followed: true,
      profile_check_attempted: 1,
      rpa_feedback: {
        relevance_level: "high",
        profile_check: { enabled: true, sampled: true },
      },
    };
    await fs.writeFile(queuePath, `${JSON.stringify(row)}\n`, "utf8");
    const restored = await restoreRunnerStateFromQueue(queuePath, confirmed);
    assert.deepEqual(restored.counters, {
      comments: 1,
      follows: 1,
      notInterested: 1,
      profileVisits: 1,
    });
    assert.equal(restored.creatorCounts.get("creator-a"), 1);
    assert.equal(restored.profileCheckedAuthors.has("creator-a"), true);
    assert.equal(restored.profileSampledAuthors.has("creator-a"), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runner persists through collector and restores counters from SQLite", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-store-"));
  const dbPath = path.join(directory, "facts.sqlite");
  try {
    const client = createCollectorClient({ dbPath });
    await client.start({
      target: confirmed.goal.observed_target,
      allVideos: true,
      forceNew: true,
    });
    const recorded = await client.record({
      run_id: confirmed.run_id,
      config_hash: confirmed.config_hash,
      is_relevant: true,
      feed_index: 1,
      observed_at: "2026-08-19T12:00:00Z",
      author: "creator-a",
      action: "not_interested",
      user_commented: true,
      user_followed: true,
      profile_check_attempted: 1,
      rpa_feedback: {
        relevance_level: "high",
        profile_check: { enabled: true, sampled: true },
      },
    });
    assert.equal(recorded.ok, true);
    const dumped = await client.runnerState({
      runId: confirmed.run_id,
      configHash: confirmed.config_hash,
    });
    const restored = restoreRunnerStateFromObservations(dumped.observations, confirmed);
    assert.deepEqual(restored.counters, {
      comments: 1,
      follows: 1,
      notInterested: 1,
      profileVisits: 1,
    });
    const synced = await client.sync();
    assert.equal(synced.local.observed, 1);
    assert.equal(synced.local.pending, 1);
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".csv")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("createDouyinRunner starts a collector session and does not require queuePath", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-runner-start-"));
  const calls = [];
  try {
    const runner = await createDouyinRunner({
      tab: {},
      runConfig: confirmed,
      activeAccountRef: confirmed.account_ref,
      outputDir: directory,
      quotaPath: path.join(directory, "quota.json"),
      collectorClient: {
        start: async (args) => {
          calls.push(["start", args]);
          return { ok: true, target: 50, count_mode: "observed" };
        },
        runnerState: async () => ({ observations: [] }),
        record: async (observation) => {
          calls.push(["record", observation]);
          return { ok: true };
        },
      },
    });
    assert.equal(calls[0][0], "start");
    assert.equal(calls[0][1].allVideos, true);
    assert.equal(typeof runner.processOne, "function");
    assert.equal(runner.state.dbPath.endsWith("douyin_rpa_session.sqlite"), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("createDouyinRunner refuses to write into a stale session with a different target", async () => {
  const draft = await read("tests/fixtures/run-config.draft.example.json");
  const confirmed = confirmRunConfig(draft, {
    confirmedBy: "user",
    confirmedAt: "2026-08-13T08:00:00.000Z",
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-stale-session-"));
  const calls = [];
  try {
    await assert.rejects(
      createDouyinRunner({
        tab: {},
        runConfig: confirmed,
        activeAccountRef: confirmed.account_ref,
        outputDir: directory,
        quotaPath: path.join(directory, "quota.json"),
        collectorClient: {
          start: async (args) => {
            calls.push(["start", args]);
            return { ok: true, target: 100, count_mode: "observed" };
          },
          runnerState: async () => ({ observations: [] }),
          record: async () => ({ ok: true }),
        },
      }),
      /未结束的会话.*不一致/,
    );
    assert.equal(calls.some(([name]) => name === "record"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
