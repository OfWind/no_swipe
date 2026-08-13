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
  quotaConfigFromRunConfig,
  resolveAccountProfile,
  updateAccountProfile,
  validateAccountProfile,
  validateRunConfig,
} from "../src/config.mjs";
import {
  createDouyinRunner,
  restoreRunnerStateFromQueue,
} from "../../skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs";

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

test("one account reuses one logical profile while revisions remain immutable", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-profile-registry-"));
  try {
    const profile = await read("tests/fixtures/account-profile.example.json");
    await bindAccountProfile(profile, { dataDir });
    assert.deepEqual(await resolveAccountProfile(profile.account_ref, { dataDir }), profile);
    await assert.rejects(bindAccountProfile(profile, { dataDir }), /已绑定画像/);

    const revision2 = {
      ...profile,
      revision: 2,
      positive_topics: [...profile.positive_topics, "暗房"],
      updated_at: "2026-08-14T00:00:00.000Z",
    };
    await updateAccountProfile(revision2, { dataDir });
    assert.equal((await resolveAccountProfile(profile.account_ref, { dataDir })).revision, 2);

    const revision1Path = path.join(
      dataDir,
      "accounts",
      (await fs.readdir(path.join(dataDir, "accounts")))[0],
      "revisions/1.json",
    );
    assert.equal(JSON.parse(await fs.readFile(revision1Path, "utf8")).revision, 1);
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
