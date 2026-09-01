import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecommendation } from "../src/browser_rules.mjs";

const profile = {
  positive_topics: ["烘焙", "咖啡"],
  high_priority_topics: ["手冲咖啡"],
  negative_topics: ["咖啡色穿搭"],
  classification: { high_match_count: 2 },
};

test("classification is driven only by the supplied account profile", () => {
  assert.deepEqual(
    classifyRecommendation({ title: "手冲咖啡水温实验" }, profile).level,
    "high",
  );
  assert.deepEqual(
    classifyRecommendation({ title: "家庭烘焙记录" }, profile).level,
    "medium",
  );
  assert.deepEqual(
    classifyRecommendation({ title: "咖啡色穿搭与烘焙色系" }, profile).level,
    "none",
  );
  assert.equal(classifyRecommendation({ title: "手机评测" }, profile).relevant, false);
});

test("classification refuses to invent a default profile", () => {
  assert.throws(() => classifyRecommendation({ title: "任意内容" }, null), /账号画像/);
});

const broadProfile = {
  selection_mode: "exclude_only",
  positive_topics: [],
  negative_topics: ["影视剪辑", "擦边"],
  excluded_creator_types: ["公司账号"],
  content_rules: {
    short_video_max_duration_seconds: 60,
    short_video_behavior: "not_interested_or_skip",
    minimum_like_count: 1000,
    below_minimum_behavior: "skip_unless_recent",
  },
  creator_rules: {
    high_relevance: {
      follower_count_min: 100000,
      follower_count_max: 200000,
      require_stable_recent_likes: true,
    },
  },
};

test("exclude-only profile watches ordinary lanes and rejects configured lanes", () => {
  const ordinary = classifyRecommendation({
    title: "城市周末散步",
    likeCount: 5000,
    creatorFollowerCount: 150000,
    creatorRecentLikesStable: true,
  }, broadProfile);
  assert.equal(ordinary.relevant, true);
  assert.equal(ordinary.high, true);

  const excluded = classifyRecommendation({ title: "明星影视剪辑", likeCount: 8000 }, broadProfile);
  assert.equal(excluded.relevant, false);
  assert.equal(excluded.notInterestedEligible, true);
});

test("low-like content skips until recent-publication evidence grants the exception", () => {
  const unknown = classifyRecommendation({ title: "普通内容", likeCount: 500 }, broadProfile);
  assert.equal(unknown.directSkip, true);
  assert.equal(unknown.needsCreatorProfile, true);
  assert.equal(unknown.notInterestedEligible, false);

  const recent = classifyRecommendation({
    title: "刚发布的普通内容",
    likeCount: 500,
    isRecentlyPublished: true,
  }, broadProfile);
  assert.equal(recent.directSkip, false);
  assert.equal(recent.recentException, true);
});

test("preset short videos at 60 seconds or less enter the immediate not-interested-or-skip lane", () => {
  for (const durationSeconds of [15, 59.9, 60]) {
    const result = classifyRecommendation({
      title: "普通城市生活",
      durationSeconds,
      likeCount: 5000,
    }, broadProfile);
    assert.equal(result.shortVideo, true);
    assert.equal(result.directSkip, true);
    assert.equal(result.notInterestedEligible, true);
    assert.equal(result.needsCreatorProfile, false);
    assert.equal(result.level, "none");
  }

  const longer = classifyRecommendation({
    title: "普通城市生活",
    durationSeconds: 60.01,
    likeCount: 5000,
    creatorFollowerCount: 150000,
    creatorRecentLikesStable: true,
  }, broadProfile);
  assert.equal(longer.shortVideo, false);
  assert.equal(longer.directSkip, false);
  assert.equal(longer.level, "high");
});

test("image-text posts always enter the immediate not-interested-or-skip lane", () => {
  const result = classifyRecommendation({
    title: "城市周末相册",
    contentType: "image_text",
    durationSeconds: null,
    likeCount: 5000,
  }, broadProfile);

  assert.equal(result.contentType, "image_text");
  assert.equal(result.imagePost, true);
  assert.equal(result.directSkip, true);
  assert.equal(result.notInterestedEligible, true);
  assert.equal(result.needsCreatorProfile, false);
  assert.equal(result.level, "none");
});
