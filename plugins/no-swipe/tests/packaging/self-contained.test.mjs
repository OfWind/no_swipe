import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_ROOT = path.resolve(ROOT, "../..");

const SHIPPED_PROMPT_ENTRYPOINTS = [
  ".codex-plugin/plugin.json",
  "skills/douyin-recommendation-rpa/SKILL.md",
  "skills/douyin-recommendation-rpa/agents/openai.yaml",
];

const CURRENT_IMPLEMENTATION_DOCS = [
  "README.md",
  "docs/no-swipe-refactor-plan-v1.md",
  "docs/no-swipe-refactor-spec-v1.md",
  "docs/no-swipe-refactor-plan-v2.md",
  "docs/no-swipe-interaction-flows.md",
  "plugins/no-swipe/README.md",
];

const SHIPPED_REFERENCES_DIRECTORY = path.join(
  ROOT,
  "skills/douyin-recommendation-rpa/references",
);

function proseStatements(source) {
  return source
    .replaceAll("\r", "")
    .split(/\n+|[!?。！？]+|(?<!\d)\.(?!\d)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function isExplicitlyProhibited(statement) {
  return /(?:never|do not|don't|must not|without opening|retired|removed|deprecated|禁止|不要|不得|切勿|避免|无需|不能|不可|废弃|已退役|已移除|未(?:打开|进入|访问|跳转|前往|停留)|不(?:再|应|可|要)?(?:打开|进入|访问|跳转|前往|停留)|不进)/i.test(statement);
}

// The logged-in account's own profile page is an allowed identity source;
// only navigation to another creator's/author's profile must stay prohibited.
function findProfileNavigationInstructions(source) {
  const navigation = /(?:\b(?:open|visit|enter|navigate(?:\s+to)?|go\s+to|stay\s+on)\b|打开|进入|访问|跳转(?:到|至)?|前往|停留(?:在)?)/i;
  const profileTarget = /(?:\b(?:author(?:'s)?|creator(?:'s)?)\b[^\n]{0,80}\b(?:profile|home\s?page)\b|(?:作者|创作者|达人)[^\n]{0,50}(?:主页|首页|个人页|资料页))/i;
  return proseStatements(source).filter((statement) => (
    navigation.test(statement)
    && profileTarget.test(statement)
    && !isExplicitlyProhibited(statement)
  ));
}

async function currentImplementationDocuments() {
  const references = (await fs.readdir(SHIPPED_REFERENCES_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(SHIPPED_REFERENCES_DIRECTORY, entry.name));

  return [
    ...CURRENT_IMPLEMENTATION_DOCS.map((file) => path.join(REPOSITORY_ROOT, file)),
    ...references,
  ];
}

function hasCurrentSurfaceIdentityInstruction(source) {
  const currentSurface = /(?:\bcurrent(?:ly visible)? (?:Douyin )?(?:page|surface|feed)\b|\bcurrent page chrome\b|\baccount menu\b|\bavatar(?: label| area)?\b|当前(?:抖音|推荐流)?(?:页面|界面)|推荐流(?:页面|界面)|账号菜单|头像(?:区域|标签|入口)?)/i;
  const identity = /(?:\b(?:identity|account|nickname|Douyin ID)\b|账号|身份|昵称|抖音号)/i;
  const resolution = /(?:\b(?:read|resolve|identify|verify|recognize)\b|读取|识别|确认|核验|认号)/i;
  return proseStatements(source).some((statement) => (
    currentSurface.test(statement)
    && identity.test(statement)
    && resolution.test(statement)
  ));
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(resolved));
    else files.push(resolved);
  }
  return files;
}

test("manifest entrypoints and assets are self-contained", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, ".codex-plugin/plugin.json"), "utf8"));
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\+codex\.[0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.version.split("+", 1)[0], packageJson.version);
  await fs.access(path.resolve(ROOT, manifest.skills));
  for (const key of ["composerIcon", "logo", "logoDark"]) {
    await fs.access(path.resolve(ROOT, manifest.interface[key]));
  }
});

test("plugin does not register default MCP servers", async () => {
  await assert.rejects(fs.access(path.join(ROOT, ".mcp.json")));
  await assert.rejects(fs.access(path.join(ROOT, ".app.json")));
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.apps, undefined);
  assert.equal(manifest.mcpServers, undefined);
});

test("all relative ESM imports resolve inside the plugin", async () => {
  const files = (await walk(ROOT)).filter((file) => file.endsWith(".mjs"));
  const missing = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const imports = [...source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(`${ROOT}${path.sep}`)) missing.push(`${path.relative(ROOT, file)} -> ${specifier} escapes plugin`);
      else await fs.access(resolved).catch(() => missing.push(`${path.relative(ROOT, file)} -> ${specifier} missing`));
    }
  }
  assert.deepEqual(missing, []);
});

test("bootstrap scripts and cli version are packaged for the host binary", async () => {
  const version = JSON.parse(await fs.readFile(path.join(ROOT, "config/cli-version.json"), "utf8"));
  assert.equal(typeof version.version, "string");
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(version.version, packageJson.version);
  await fs.access(path.join(ROOT, "scripts/bootstrap.sh"));
  await fs.access(path.join(ROOT, "scripts/bootstrap.ps1"));
  const supabase = JSON.parse(await fs.readFile(path.join(ROOT, "config/supabase.json"), "utf8"));
  assert.match(supabase.workbench_url, /^https:\/\//);
  assert.match(supabase.releases_base_url, /no-swipe-releases/);
});

test("bootstrap keeps the current binary and deletes older version directories", async () => {
  const version = JSON.parse(await fs.readFile(path.join(ROOT, "config/cli-version.json"), "utf8")).version;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-bootstrap-"));
  const binRoot = path.join(home, ".config/no-swipe/bin");
  try {
    await fs.mkdir(path.join(binRoot, "0.3.5"), { recursive: true });
    await fs.writeFile(path.join(binRoot, "0.3.5/no-swipe"), "old");
    await fs.mkdir(path.join(binRoot, version), { recursive: true });
    const currentBin = path.join(binRoot, version, "no-swipe");
    await fs.writeFile(currentBin, "#!/bin/sh\necho '{\"ok\":true,\"stub\":\"'\"$1\"'\"}'\n");
    await fs.chmod(currentBin, 0o755);
    await fs.mkdir(path.join(binRoot, "keep-me"), { recursive: true });
    await fs.writeFile(path.join(home, ".config/no-swipe/credentials.json"), "{\"ok\":true}\n");
    const { stdout } = await execFileAsync("bash", [path.join(ROOT, "scripts/bootstrap.sh")], {
      env: { ...process.env, HOME: home, NO_SWIPE_HOME: home },
    });
    const lines = stdout.trim().split("\n");
    const result = JSON.parse(lines[0]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.pruned_bins, ["0.3.5"]);
    const chained = JSON.parse(lines[1]);
    assert.equal(chained.stub, "up");
    await fs.access(path.join(binRoot, version, "no-swipe"));
    await fs.access(path.join(binRoot, "keep-me"));
    await fs.access(path.join(home, ".config/no-swipe/credentials.json"));
    await assert.rejects(fs.access(path.join(binRoot, "0.3.5")));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("marketplace and plugin versions stay paired for Codex cache activation", async () => {
  const version = JSON.parse(await fs.readFile(path.join(ROOT, "config/cli-version.json"), "utf8")).version;
  const plugin = JSON.parse(await fs.readFile(path.join(ROOT, ".codex-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(await fs.readFile(path.join(ROOT, "../../.agents/plugins/marketplace.json"), "utf8"));
  assert.equal(plugin.version.split("+", 1)[0], version);
  assert.equal(marketplace.version, version);
  assert.equal(marketplace.plugins[0].version, version);
});

test("product entrypoints do not contain the former test persona or implicit execution flags", async () => {
  const sources = await Promise.all([
    ".codex-plugin/plugin.json",
    "skills/douyin-recommendation-rpa/SKILL.md",
    "skills/douyin-recommendation-rpa/agents/openai.yaml",
  ].map((file) => fs.readFile(path.join(ROOT, file), "utf8")));
  const combined = sources.join("\n");
  const manifestContent = JSON.stringify(JSON.parse(sources[0]));
  assert.doesNotMatch(combined, /executeFollow\s*:\s*true|executeComments\s*:\s*true/);
  assert.doesNotMatch(manifestContent, /科技|3C|人工智能/i);
  assert.doesNotMatch(sources[2], /科技|3C|人工智能/i);
});

test("all shipped prompts resolve identity current-surface-first without creator-profile navigation", async () => {
  for (const file of SHIPPED_PROMPT_ENTRYPOINTS) {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    assert.deepEqual(
      findProfileNavigationInstructions(source),
      [],
      `${file} must not instruct the agent to open another creator's profile`,
    );
    assert.ok(
      hasCurrentSurfaceIdentityInstruction(source),
      `${file} must resolve the visible Douyin identity from the current page, account menu, or avatar`,
    );
  }
});

test("current implementation docs do not prescribe author or creator profile navigation", async () => {
  for (const file of await currentImplementationDocuments()) {
    const source = await fs.readFile(file, "utf8");
    const label = path.relative(REPOSITORY_ROOT, file);
    assert.deepEqual(
      findProfileNavigationInstructions(source),
      [],
      `${label} contains an instruction to navigate to a creator profile`,
    );
  }
});

test("current implementation docs keep profile sampling retired", async () => {
  const sources = await Promise.all((await currentImplementationDocuments()).map(
    (file) => fs.readFile(file, "utf8"),
  ));
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /profile sampling 由 runner 单独按作者抽样/i);
  assert.doesNotMatch(combined, /positive[^\n.]*profile[- ]visit rates? require total caps/i);
  assert.doesNotMatch(combined, /作者主页证据入口优先点击/);
  assert.doesNotMatch(combined, /持久化[^\n。]*主页抽样集合/);
  assert.match(combined, /profile sampling[^\n。]*(?:retired|disabled|已退役|已禁用)/i);
});

test("shipped preset keeps creator-profile traversal disabled", async () => {
  const preset = JSON.parse(await fs.readFile(
    path.join(ROOT, "config/presets/douyin-youth-white-collar.v1.json"),
    "utf8",
  ));
  const interactionPolicy = preset.run_defaults.interaction_policy;
  const authorization = preset.run_defaults.authorization;

  assert.equal(authorization.profile_visit, false);
  assert.deepEqual(interactionPolicy.profile_sampling, { rate: 0, max_total: 0 });
  assert.deepEqual(
    preset.profile.content_rules.recent_evidence_sources,
    ["feed_published_at"],
  );
  // Follower-count creator rules are retired: that evidence is not visible
  // on the feed and homepage collection is banned, so keeping the rule would
  // silently disable every positive interaction.
  assert.equal(preset.profile.creator_rules, undefined);
  assert.doesNotMatch(preset.user_facing_copy, /粉丝量|粉丝数/);

  const userFacingText = [preset.user_facing_copy, preset.confirmation_notice].join("\n");
  assert.deepEqual(findProfileNavigationInstructions(userFacingText), []);
  assert.doesNotMatch(userFacingText, /(?:作者主页(?:作品)?列表|主页访问权限|creator_profile)/i);
});

test("page-fact extractor ships as an evaluate-ready adapter with stable selectors", async () => {
  const extractor = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/douyin_page_facts.js"),
    "utf8",
  );
  assert.ok(extractor.trimStart().startsWith("() => {"), "must be a single evaluate-ready arrow function");
  for (const selector of [
    'data-e2e="feed-active-video"',
    'data-e2e="video-player-digg"',
    'data-e2e="feed-video-nickname"',
    'data-e2e="video-desc"',
    'data-e2e="video-avatar"',
    'data-e2e="video-switch-next-arrow"',
  ]) {
    assert.ok(extractor.includes(selector), `extractor must keep selector ${selector}`);
  }
  assert.doesNotMatch(extractor, /\.click\(|\bgoto\(|history\./, "extractor must be read-only");
});

test("page-action adapter ships evaluate-ready with the retired runner's mechanics", async () => {
  const adapter = await fs.readFile(
    path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/douyin_page_actions.js"),
    "utf8",
  );
  assert.ok(adapter.trimStart().startsWith("(plan) => {"), "must be a single evaluate-ready arrow function taking the plan");
  for (const selector of [
    'data-e2e="feed-active-video"',
    'data-e2e="video-player-digg"',
    'data-e2e="video-player-collect"',
    'data-e2e="feed-follow-icon"',
    'data-e2e="video-switch-next-arrow"',
  ]) {
    assert.ok(adapter.includes(selector), `adapter must keep selector ${selector}`);
  }
  // Labels and settles from config/platforms/douyin.v1.json via the 0.2.x runner.
  for (const label of ["不感兴趣", "继续播放", "关注成功"]) {
    assert.ok(adapter.includes(label), `adapter must keep label ${label}`);
  }
  assert.ok(adapter.includes("data-e2e-state"), "adapter must verify post-click state");
  assert.doesNotMatch(adapter, /\bgoto\(|history\./, "adapter must never navigate");
});

test("retired Node runner and Python collector are not shipped", async () => {
  await assert.rejects(fs.access(path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs")));
  await assert.rejects(fs.access(path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/douyin_rpa_collector.py")));
  await assert.rejects(fs.access(path.join(ROOT, "runtime/src/cli.mjs")));
  await assert.rejects(fs.access(path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/collector_client.mjs")));
  await assert.rejects(fs.access(path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/collector")));
  await assert.rejects(fs.access(path.join(ROOT, "tests/collector")));
});

test("bundled schemas and configuration files are valid JSON", async () => {
  const files = (await walk(path.join(ROOT, "config"))).filter((file) => file.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const file of files) JSON.parse(await fs.readFile(file, "utf8"));
});
