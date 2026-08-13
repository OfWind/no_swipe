import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecommendation } from "../../skills/douyin-recommendation-rpa/scripts/douyin_rpa_browser_rules.mjs";

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
