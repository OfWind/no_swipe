import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("skill gates every run on device pairing before browser access", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  const authSection = skill.indexOf("## 0. Authorize data upload before browser access");
  const statusCall = skill.indexOf("`no-swipe auth status`");
  const browserSection = skill.indexOf("## 1. Open the account profile after upload authorization");

  assert.ok(authSection >= 0, "runtime auth gate is required");
  assert.ok(authSection < statusCall && statusCall < browserSection);
  assert.match(skill, /description:.*Verify No Swipe upload authorization before every browser action/);
  assert.match(skill, /mandatory for every new or resumed run/);
  assert.match(skill, /no-swipe auth login/);
  assert.match(skill, /scripts\/bootstrap/);
  assert.doesNotMatch(skill, /codex mcp add no-swipe|get_upload_status|ingest_observation_batch/);
  assert.match(skill, /Do not tell the user to re-enable the plugin/);
  assert.match(skill, /new Codex task/);
  assert.match(skill, /Stop before all Douyin, collector, Goal, and upload actions/);
  assert.match(skill, /Accept any email that can receive and verify the No Swipe OTP/);
  assert.match(skill, /NO_SWIPE_PLUGIN_ROOT/);
  assert.match(skill, /SmartScreen or 360/);
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

test("user-visible Goal is Chinese and keeps internal identifiers private", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  const goalStart = skill.indexOf("## 4. Create one durable Goal");
  const goalEnd = skill.indexOf("## 5. Apply the configured feed rules");
  const goalSection = skill.slice(goalStart, goalEnd);

  assert.match(goalSection, /为当前已确认的抖音账号/);
  assert.match(goalSection, /内部运行标识只保存在本地配置和状态文件中/);
  assert.doesNotMatch(goalSection, /Execute Douyin run|<run_id>|<account_ref>|<config_hash>/);
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

test("skill preserves a one-to-many No Swipe user to Douyin account registry", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /1:n relationship/);
  assert.match(skill, /never replaces, renames, or deletes an existing account directory/);
  assert.match(skill, /Switching Douyin accounts selects another stored profile/);
  assert.match(skill, /Do not put the login email in `account_ref`/);
});

test("skill keeps collector record out of the feed loop", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /`no-swipe step` commits each observation to SQLite and its durable outbox/);
  assert.match(skill, /Do not call collector `record`/);
  assert.match(skill, /no-swipe sync/);
  assert.match(skill, /no-swipe finish/);
  assert.doesNotMatch(skill, /mcp_upload|ingest_observation_batch|mcp-ack/);
});

test("skill treats CSV and Excel as on-demand exports from SQLite", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /committed to SQLite and its durable outbox/);
  assert.match(skill, /Do not write CSV or Excel during collection/);
  assert.match(skill, /export from SQLite with `no-swipe export`/);
  assert.match(skill, /CSV and Excel are on-demand exports, not live copies/);
});

test("skill prioritizes the confirmed 60-second immediate lane", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /60 seconds or less enters the immediate lane/);
  assert.match(skill, /otherwise swipe immediately/);
  assert.match(skill, /Do not wait, visit the creator homepage, or allocate like/);
});

test("skill routes browser anomalies to same-surface diagnostics", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /references\/browser-diagnostics\.md/);
  assert.match(skill, /bounded same-surface ladder/);
});
