import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("skill gates every run on No Swipe OAuth before browser access", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  const authSection = skill.indexOf("## 0. Authorize data upload before browser access");
  const statusCall = skill.indexOf("`get_upload_status`");
  const browserSection = skill.indexOf("## 1. Open the account profile after upload authorization");

  assert.ok(authSection >= 0, "runtime OAuth gate is required");
  assert.ok(authSection < statusCall && statusCall < browserSection);
  assert.match(skill, /description:.*Verify No Swipe upload authorization before every browser action/);
  assert.match(skill, /mandatory for every new or resumed run/);
  assert.match(skill, /codex mcp login no-swipe/);
  assert.match(skill, /the agent must run/);
  assert.match(skill, /Never ask the user to type, copy, or paste this command/);
  assert.match(skill, /stop before all Douyin, collector, Goal, and upload actions/);
  assert.match(skill, /Accept any email that can receive and verify the No Swipe OTP/);
});

test("skill waits for a compact chat answer before goal execution", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  const questionIndex = skill.indexOf("请回复“使用预设并开始”");
  const confirmIndex = skill.indexOf("run confirm <draft.json>");
  const goalIndex = skill.indexOf("create_goal");
  const feedIndex = skill.indexOf("## 5. Apply the configured feed rules");

  assert.ok(questionIndex >= 0, "compact chat confirmation is required");
  assert.match(skill, /End the current turn/);
  assert.doesNotMatch(skill, /request_user_input|requestUserInput/);
  assert.ok(questionIndex < confirmIndex && confirmIndex < goalIndex && goalIndex < feedIndex);
});

test("skill defines explicit extend and replace semantics", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /`使用预设，300条` use `extend`/);
  assert.match(skill, /copy no value from the preset into the replaced scope/);
  assert.match(skill, /--profile-mode <preset\|extend\|replace>/);
});
