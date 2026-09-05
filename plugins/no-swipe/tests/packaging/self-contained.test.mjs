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

const SHIPPED_PROMPT_ENTRYPOINTS = [
  ".codex-plugin/plugin.json",
  "skills/douyin-recommendation-rpa/SKILL.md",
  "skills/douyin-recommendation-rpa/agents/openai.yaml",
  "skills/no-swipe-release-loop/SKILL.md",
  "skills/no-swipe-release-loop/agents/openai.yaml",
];

function proseStatements(source) {
  return source
    .replaceAll("\r", "")
    .split(/\n+|[!?。！？]+|(?<!\d)\.(?!\d)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function isExplicitlyProhibited(statement) {
  return /(?:never|do not|don't|must not|without opening|retired|removed|deprecated|禁止|不要|不得|切勿|避免|无需|不能|不可|废弃|已退役|已移除|未(?:打开|进入|访问|导航|跳转|前往|停留)|不(?:再|应|可|要)?(?:打开|进入|访问|导航|跳转|前往|停留)|不进)/i.test(statement);
}

// Every new task starts identity on the canonical self page. Current-page,
// account-menu, or avatar nicknames are a bounded exact-match fallback;
// another creator profile is never an identity input.
function findProfileNavigationInstructions(source) {
  const navigation = /(?:\b(?:open|visit|enter|navigate(?:\s+to)?|go\s+to|stay\s+on)\b|打开|进入|访问|跳转(?:到|至)?|前往|停留(?:在)?)/i;
  const profileTarget = /(?:\b(?:author(?:'s)?|creator(?:'s)?)\b[^\n]{0,80}\b(?:profile|home\s?page)\b|(?:作者|创作者|达人)[^\n]{0,50}(?:主页|首页|个人页|资料页))/i;
  return proseStatements(source).filter((statement) => (
    navigation.test(statement)
    && profileTarget.test(statement)
    && !isExplicitlyProhibited(statement)
  ));
}

function hasCurrentSurfaceIdentityInstruction(source) {
  const currentSurface = /(?:\bcurrent(?:ly visible)? (?:Douyin )?(?:page|surface|feed)\b|\bcurrent page chrome\b|\baccount menu\b|\bavatar(?: label| area)?\b|当前(?:抖音|推荐流)?(?:页面|界面)|推荐流(?:页面|界面)|账号菜单|头像(?:区域|标签|入口)?)/i;
  const identity = /(?:\b(?:identity|account|nickname|Douyin ID)\b|账号|身份|昵称|抖音号)/i;
  const resolution = /(?:\b(?:read|resolve|identify|verify|recognize|match(?:es)?)\b|读取|识别|确认|核验|匹配|认号)/i;
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
  assert.equal(supabase.workbench_url, "https://fai.zhuanspirit.com/creators");
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.homepage, `${supabase.workbench_url}/`);
  assert.equal(manifest.interface.websiteURL, `${supabase.workbench_url}/`);
  assert.equal(manifest.interface.privacyPolicyURL, `${supabase.workbench_url}/privacy`);
  assert.equal(manifest.interface.termsOfServiceURL, `${supabase.workbench_url}/terms`);
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
    await fs.writeFile(path.join(home, ".config/no-swipe/supabase.json"), JSON.stringify({
      workbench_url: "https://legacy.example/workbench",
    }));
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
    assert.equal(await fs.readFile(path.join(home, ".config/no-swipe/credentials.json"), "utf8"), "{\"ok\":true}\n");
    assert.equal(
      await fs.readFile(path.join(home, ".config/no-swipe/supabase.json"), "utf8"),
      await fs.readFile(path.join(ROOT, "config/supabase.json"), "utf8"),
    );
    await assert.rejects(fs.access(path.join(binRoot, "0.3.5")));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("product entrypoints do not contain the former test persona or implicit execution flags", async () => {
  const sources = await Promise.all(SHIPPED_PROMPT_ENTRYPOINTS.map(
    (file) => fs.readFile(path.join(ROOT, file), "utf8"),
  ));
  const combined = sources.join("\n");
  const manifestContent = JSON.stringify(JSON.parse(sources[0]));
  assert.doesNotMatch(combined, /executeFollow\s*:\s*true|executeComments\s*:\s*true/);
  assert.doesNotMatch(manifestContent, /科技|3C|人工智能/i);
  assert.doesNotMatch(sources[2], /科技|3C|人工智能/i);
});

test("all shipped prompts start new-task identity on the canonical self page", async () => {
  for (const file of SHIPPED_PROMPT_ENTRYPOINTS) {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    assert.match(
      source,
      /(?:every new Codex task|每个新任务)/i,
      `${file} must repeat identity for each new task`,
    );
    assert.match(
      source,
      /https:\/\/www\.douyin\.com\/user\/self/i,
      `${file} must use the canonical logged-in-account identity page`,
    );
    assert.deepEqual(
      findProfileNavigationInstructions(source),
      [],
      `${file} must not instruct the agent to open another creator's profile`,
    );
    assert.ok(
      hasCurrentSurfaceIdentityInstruction(source),
      `${file} must retain the current-page exact-nickname fallback`,
    );
  }
});

test("all shipped prompts keep the Chrome-Edge-built-in browser contract", async () => {
  for (const file of SHIPPED_PROMPT_ENTRYPOINTS) {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    assert.match(
      source,
      /Chrome/i,
      `${file} must include Chrome as the first browser family`,
    );
    assert.match(
      source,
      /Edge/i,
      `${file} must include Edge as the second browser family`,
    );
    assert.match(
      source,
      /(?:built-in browser|内置浏览器)/i,
      `${file} must retain the built-in browser fallback`,
    );
    assert.match(
      source,
      /(?:before any (?:workbench or Douyin )?page action|before the first page action|首次页面操作前)/i,
      `${file} must limit fallback to startup`,
    );
    assert.match(
      source,
      /(?:never use Safari|no Safari runtime path|Safari (?:is )?(?:unsupported|not a supported)|Safari (?:is|must be) never selected|不使用 Safari|Safari 不是 No Swipe 支持的运行浏览器)/i,
      `${file} must exclude Safari from the No Swipe runtime`,
    );
  }
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
  // The Codex evaluate scope is read-only and strips bare globals: only
  // namespace functions (Number.*, Math.*) are guaranteed to exist there.
  assert.doesNotMatch(extractor, /[^.\w]parseFloat\b/, "must use Number.parseFloat, not the stripped bare global");
  assert.doesNotMatch(extractor, /setTimeout|dispatchEvent/, "timers and event dispatch do not work in the read-only scope");
  // Negative-first state resolution: the resting markers video-player-no-digged
  // / no-collect substring-match every positive word, so negatives must win.
  assert.ok(extractor.includes('["no-digged", "not-digged"]'), "liked state must resolve negatives first");
  assert.ok(extractor.includes('["no-collect", "not-collect"]'), "favorited state must resolve negatives first");
  // The feed renders one switch arrow per slide; existence must be scoped to
  // the active slide, not the document.
  assert.ok(extractor.includes("q('[data-e2e=\"video-switch-next-arrow\"]')"), "can_switch_next must be scoped to the active slide");
  assert.doesNotMatch(extractor, /document\.querySelector\('\[data-e2e="video-switch-next-arrow"\]'\)/, "unscoped arrow lookups match every slide");
  // Recommend-feed slider omits feed-active-video; class video_<id> is the id.
  assert.ok(extractor.includes("sliderVideo"), "slider / relatedUiAdapter layout must be a player fallback");
  assert.ok(extractor.includes("relatedUiAdapter"), "relatedUiAdapter must be a player fallback");
  assert.ok(extractor.includes("visible_card_count"), "waterfall geometry must distinguish 0x0 cards from clickable cards");
  assert.ok(extractor.includes("playing_video_count"), "must report a visible playing video so agents do not click collapsed cards");
  assert.ok(extractor.includes("siblingSlides"), "viewport-visible slider siblings may count as can_switch_next");
  assert.ok(extractor.includes("window.innerWidth"), "slide visibility must be clipped to the viewport width");
  assert.ok(extractor.includes("window.innerHeight"), "slide visibility must be clipped to the viewport height");
  assert.ok(extractor.includes('content_type: contentType'), "page facts must report video versus image-text content");
  assert.ok(extractor.includes('feed-live'), "page facts must recognize live-room chrome");
  assert.ok(extractor.includes("进入直播间"), "page facts must recognize the live-entry control");
  assert.ok(extractor.includes("tplv-dy-aweme-images"), "page facts must recognize Douyin gallery resources");
  assert.ok(extractor.includes("gallery_image_count"), "page facts must report deduplicated gallery image count");
});


test("the live-tab JS runner is shipped while retired action and collector paths stay absent", async () => {
  const runnerPath = path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs");
  const runner = await fs.readFile(runnerPath, "utf8");
  assert.match(runner, /export async function createDouyinRunner/);
  assert.match(runner, /processOne/);
  assert.match(runner, /tab\.playwright\.locator/);
  assert.match(runner, /tab\.cua\.keypress/);
  assert.match(runner, /tab\.cua\.scroll/);
  assert.match(runner, /status: "commit_failed"/);
  assert.doesNotMatch(runner, /\/user\/|creator homepage|author homepage/i);
  await assert.rejects(fs.access(path.join(ROOT, "skills/douyin-recommendation-rpa/scripts/douyin_page_actions.js")));
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
