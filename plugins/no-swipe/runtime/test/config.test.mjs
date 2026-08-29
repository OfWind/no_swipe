import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConfigValidationError,
  bindAccountProfile,
  computeConfigHash,
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
  assert.deepEqual(result.profile.content_rules.recent_evidence_sources, ["feed_published_at"]);
  assert.equal(result.profile.creator_rules, undefined);
  assert.equal(result.run_config.interaction_policy.rules[0].like_rate, 0.1);
  assert.equal(result.run_config.interaction_policy.follow.rate, 0.03);
  assert.equal(result.run_config.interaction_policy.rules[0].comment_rate, 0);
  assert.deepEqual(result.run_config.interaction_policy.profile_sampling, { rate: 0, max_total: 0 });
  assert.equal(result.run_config.authorization.profile_visit, false);
  assert.ok(Object.entries(result.run_config.authorization).every(([key, value]) => key === "profile_visit" || value === true));
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
  assert.equal(result.run_config.goal.observed_target, 1000);
});

test("materialize preserves the revision and created_at of an existing profile input", async () => {
  const preset = await read("config/presets/douyin-youth-white-collar.v1.json");
  const existingProfile = materializeOnboardingPreset(preset, {
    accountRef: "douyin:82338116099",
    profileId: "profile-82338116099",
    runId: "run-existing-base",
    timestamp: "2026-08-13T08:00:00.000Z",
  }).profile;
  existingProfile.revision = 2;
  existingProfile.updated_at = "2026-08-20T08:00:00.000Z";
  const result = materializeOnboardingPreset(preset, {
    accountRef: "douyin:82338116099",
    profileId: "profile-82338116099",
    runId: "run-existing-test",
    timestamp: "2026-08-26T08:00:00.000Z",
    profileMode: "replace",
    profileInput: existingProfile,
  });
  assert.equal(result.profile.revision, 2);
  assert.equal(result.profile.created_at, "2026-08-13T08:00:00.000Z");
  assert.equal(result.run_config.interest_profile.revision, 2);
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

test("product defaults keep profile visits off and still require confirmation", async () => {
  const defaults = await read("config/defaults/safe-runtime.json");
  assert.equal(defaults.authorization_defaults.profile_visit, false);
  assert.deepEqual(defaults.interaction_policy_defaults.profile_sampling, { rate: 0, max_total: 0 });
  assert.ok(Object.entries(defaults.authorization_defaults).every(([key, value]) => key === "profile_visit" || value === true));
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

test("new runs reject profile navigation while legacy sealed configs remain readable but runtime-disabled", async () => {
  const unsafeDraft = await read("tests/fixtures/run-config.draft.example.json");
  unsafeDraft.interaction_policy.profile_sampling = { rate: 1, max_total: 50 };
  unsafeDraft.authorization.profile_visit = true;
  assert.throws(
    () => validateRunConfig(unsafeDraft),
    (error) => error instanceof ConfigValidationError
      && error.issues.some((issue) => issue.path === "$.interaction_policy.profile_sampling.rate")
      && error.issues.some((issue) => issue.path === "$.interaction_policy.profile_sampling.max_total")
      && error.issues.some((issue) => issue.path === "$.authorization.profile_visit"),
  );

  const legacyConfirmed = structuredClone(unsafeDraft);
  legacyConfirmed.status = "confirmed";
  legacyConfirmed.confirmed_at = "2026-08-13T08:00:00.000Z";
  legacyConfirmed.confirmed_by = "user";
  legacyConfirmed.config_hash = computeConfigHash(legacyConfirmed);
  assert.equal(validateRunConfig(legacyConfirmed, { requireConfirmed: true }), legacyConfirmed);
  assert.deepEqual(quotaConfigFromRunConfig(legacyConfirmed).profileVisit, {
    authorized: false,
    rate: 0,
    maxTotal: 0,
  });
  assert.throws(() => confirmRunConfig(legacyConfirmed, { confirmedBy: "user" }), ConfigValidationError);
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
  assert.deepEqual(quota.profileVisit, { authorized: false, rate: 0, maxTotal: 0 });
  assert.equal(quota.runConfigHash, confirmed.config_hash);
});
