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

test("skill keeps collector record and MCP drain out of the feed loop", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /`processOne` commits each observation to SQLite and its durable outbox/);
  assert.match(skill, /Do not call collector `record`/);
  assert.match(skill, /do not inspect `mcp_upload` during the feed loop/);
  assert.match(skill, /collector `sync --force`/);
  assert.match(skill, /collector\s+`finish` once to close the active session/);
  assert.doesNotMatch(skill, /After every collector `start`, `record`, and `finish`/);
});

test("skill treats CSV and Excel as on-demand exports from SQLite", async () => {
  const skill = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /committed to SQLite and its durable outbox/);
  assert.match(skill, /Do not write CSV or Excel during collection/);
  assert.match(skill, /export from SQLite with collector `export`/);
  assert.match(skill, /CSV and Excel are on-demand exports, not live copies/);
  assert.doesNotMatch(skill, /CSV\/JSONL kept only as mirrors/);
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
  const diagnostics = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/references/browser-diagnostics.md"),
    "utf8",
  );

  assert.match(skill, /references\/browser-diagnostics\.md/);
  assert.match(skill, /bounded same-surface ladder/);
  assert.match(skill, /external pass never proves/);
  assert.match(diagnostics, /`codex_iab`/);
  assert.match(diagnostics, /`external_chrome_devtools`/);
  assert.match(diagnostics, /Do not retry an identical timed-out probe/);
  assert.match(diagnostics, /An external pass never means `codex_iab` recovered/);
  assert.match(diagnostics, /codex mcp add chrome-devtools/);
  assert.match(diagnostics, /chrome-devtools-mcp@<validated-version>/);
});
