import assert from "node:assert/strict";
import test from "node:test";
import { DouyinQuotaPolicy, createDouyinQuotaPolicy } from "../src/quota_policy.mjs";

// Ported verbatim from the retired plugin-side douyin_quota_randomizer.test.mjs;
// the file-based resume test now round-trips through snapshot()/fromSnapshot()
// because persistence moved into SQLite.

const countActions = (decisions) => ({
  like: decisions.filter((item) => item.plannedActions.like).length,
  favorite: decisions.filter((item) => item.plannedActions.favorite).length,
  both: decisions.filter((item) => item.plannedActions.like && item.plannedActions.favorite).length,
  anyInteraction: decisions.filter((item) => item.plannedActions.like || item.plannedActions.favorite).length,
  complete: decisions.filter((item) => item.plannedActions.watchToEnd).length,
  comments: decisions.filter((item) => item.plannedActions.comment).length,
});

const EXPLICIT_TEST_CONFIG = {
  highInteraction: {
    blockSize: 100,
    rates: { like_only: 0.23, favorite_only: 0.08, like_and_favorite: 0.07, none: 0.62 },
  },
  mediumInteraction: {
    blockSize: 20,
    rates: { like_only: 0.15, favorite_only: 0, like_and_favorite: 0, none: 0.85 },
  },
  completion: { blockSize: 10, rates: { complete: 0.10, not_complete: 0.90 } },
};

test("safe defaults plan nothing and profile visits stay retired", () => {
  const safePolicy = createDouyinQuotaPolicy({ config: { seed: "safe-default-test" } });
  const safeDecision = safePolicy.decide({ awemeId: "safe", relevance: "high", contentType: "video", durationSeconds: 60 });
  assert.deepEqual(safeDecision.plannedActions, {
    like: false,
    favorite: false,
    watchToEnd: false,
    comment: false,
    follow: false,
    notInterested: false,
    profileVisit: false,
  });
  assert.deepEqual(safePolicy.config.profileVisit, { authorized: false, rate: 0, maxTotal: 0 });

  const legacyProfilePolicy = createDouyinQuotaPolicy({
    config: { profileVisit: { authorized: true, rate: 1, maxTotal: 1000 } },
  });
  assert.deepEqual(legacyProfilePolicy.config.profileVisit, { authorized: false, rate: 0, maxTotal: 0 });
  assert.equal(legacyProfilePolicy.decide({ awemeId: "legacy-profile", relevance: "high" }).plannedActions.profileVisit, false);
});

test("high and medium lanes realize exact per-block counts", () => {
  const policy = createDouyinQuotaPolicy({ config: { seed: "quota-unit-test", ...EXPLICIT_TEST_CONFIG } });
  const highDecisions = [];
  for (let index = 1; index <= 100; index += 1) {
    highDecisions.push(policy.decide({
      awemeId: `high-${index}`,
      relevance: "high",
      contentType: "video",
      durationSeconds: 60,
      pageState: "ok",
    }));
  }
  assert.deepEqual(countActions(highDecisions), {
    like: 30,
    favorite: 15,
    both: 7,
    anyInteraction: 38,
    complete: 10,
    comments: 0,
  });

  const mediumDecisions = [];
  for (let index = 1; index <= 20; index += 1) {
    mediumDecisions.push(policy.decide({
      awemeId: `medium-${index}`,
      relevance: "medium",
      contentType: "video",
      durationSeconds: 40,
      pageState: "ok",
    }));
  }
  assert.equal(mediumDecisions.filter((item) => item.plannedActions.like).length, 3);
  assert.equal(mediumDecisions.filter((item) => item.plannedActions.favorite).length, 0);
  assert.equal(mediumDecisions.filter((item) => item.plannedActions.watchToEnd).length, 0);

  // Re-seeing the same aweme id reuses the assignment without consuming quota.
  const duplicateBefore = policy.summary().pools.highInteraction.eligibleCount;
  const duplicateDecision = policy.decide({
    awemeId: "high-1",
    relevance: "high",
    contentType: "video",
    durationSeconds: 60,
    pageState: "ok",
  });
  assert.equal(duplicateDecision.reusedAssignment, true);
  assert.equal(policy.summary().pools.highInteraction.eligibleCount, duplicateBefore);
});

test("completion pool honors its own block rates", () => {
  const higherCompletionPolicy = createDouyinQuotaPolicy({
    config: {
      seed: "higher-completion-unit-test",
      ...EXPLICIT_TEST_CONFIG,
      completion: { blockSize: 20, rates: { complete: 0.15, not_complete: 0.85 } },
    },
  });
  const decisions = [];
  for (let index = 1; index <= 100; index += 1) {
    decisions.push(higherCompletionPolicy.decide({
      awemeId: `higher-completion-${index}`,
      relevance: "high",
      contentType: "video",
      durationSeconds: 120,
      pageState: "ok",
    }));
  }
  assert.equal(decisions.filter((item) => item.plannedActions.watchToEnd).length, 15);
});

test("follow candidates stay unique per creator and stop states allocate nothing", () => {
  const followPolicy = createDouyinQuotaPolicy({
    config: {
      seed: "follow-unit-test",
      follow: { blockSize: 20, rates: { candidate: 0.05, not_candidate: 0.95 } },
    },
  });
  const followDecisions = [];
  for (let index = 1; index <= 20; index += 1) {
    followDecisions.push(followPolicy.decide({
      awemeId: `creator-video-${index}`,
      relevance: "high",
      contentType: "video",
      durationSeconds: 240,
      author: `重复高相关创作者-${index}`,
      repeatHighCreatorCount: 2,
      feedFollowVisible: true,
      pageState: "ok",
    }));
  }
  assert.equal(followDecisions.filter((item) => item.followCandidate).length, 1);
  assert.equal(followDecisions.filter((item) => item.followCandidateNewlyAssigned).length, 1);
  assert.equal(followDecisions.filter((item) => item.plannedActions.follow).length, 1);
  assert.equal(followPolicy.summary().planned.uniqueFollowCandidates, 1);

  const selectedFollowDecision = followDecisions.find((item) => item.followCandidate);
  const selectedCreatorNumber = followDecisions.indexOf(selectedFollowDecision) + 1;
  const followPoolBeforeRepeat = followPolicy.summary().pools.follow.eligibleCount;
  const repeatedCreatorDecision = followPolicy.decide({
    awemeId: "same-creator-another-video",
    relevance: "high",
    contentType: "video",
    durationSeconds: 240,
    author: `重复高相关创作者-${selectedCreatorNumber}`,
    repeatHighCreatorCount: 3,
    feedFollowVisible: true,
    pageState: "ok",
  });
  assert.equal(repeatedCreatorDecision.followCandidate, true);
  assert.equal(repeatedCreatorDecision.followCandidateNewlyAssigned, false);
  assert.equal(followPolicy.summary().pools.follow.eligibleCount, followPoolBeforeRepeat);
  assert.equal(followPolicy.summary().planned.uniqueFollowCandidates, 1);

  const assignmentsBeforeStop = followPolicy.summary().planned.assignedContent;
  const stopDecision = followPolicy.decide({
    awemeId: "must-not-allocate",
    relevance: "high",
    contentType: "video",
    durationSeconds: 30,
    pageState: "verification",
  });
  assert.equal(stopDecision.stopRequired, true);
  assert.equal(followPolicy.summary().planned.assignedContent, assignmentsBeforeStop);
});

test("snapshot round-trip resumes exactly where the policy stopped", () => {
  const resumablePolicy = createDouyinQuotaPolicy({ config: { seed: "resume-unit-test", ...EXPLICIT_TEST_CONFIG } });
  for (let index = 1; index <= 50; index += 1) {
    resumablePolicy.decide({
      awemeId: `resume-${index}`,
      relevance: "high",
      contentType: "video",
      durationSeconds: 60,
      pageState: "ok",
    });
  }
  const restoredPolicy = DouyinQuotaPolicy.fromSnapshot(JSON.parse(JSON.stringify(resumablePolicy.snapshot())));
  for (let index = 51; index <= 100; index += 1) {
    restoredPolicy.decide({
      awemeId: `resume-${index}`,
      relevance: "high",
      contentType: "video",
      durationSeconds: 60,
      pageState: "ok",
    });
  }
  const restoredSummary = restoredPolicy.summary();
  assert.deepEqual(restoredSummary.pools.highInteraction.actualCounts, {
    like_only: 23,
    favorite_only: 8,
    like_and_favorite: 7,
    none: 62,
  });
  assert.deepEqual(restoredSummary.pools.completion.actualCounts, {
    complete: 10,
    not_complete: 90,
  });
});
