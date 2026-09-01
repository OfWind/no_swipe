import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertVersionState } from "./set-version.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(REPOSITORY_ROOT, "plugins/no-swipe");

const CURRENT_IMPLEMENTATION_DOCS = [
  "README.md",
  "docs/no-swipe-refactor-plan-v1.md",
  "docs/no-swipe-refactor-spec-v1.md",
  "docs/no-swipe-refactor-plan-v2.md",
  "docs/no-swipe-interaction-flows.md",
  "plugins/no-swipe/README.md",
];

const SHIPPED_REFERENCES_DIRECTORIES = [
  path.join(PLUGIN_ROOT, "skills/douyin-recommendation-rpa/references"),
  path.join(PLUGIN_ROOT, "skills/no-swipe-release-loop/references"),
];

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
  const references = (await Promise.all(SHIPPED_REFERENCES_DIRECTORIES.map(async (directory) => (
    (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(directory, entry.name))
  )))).flat();

  return [
    ...CURRENT_IMPLEMENTATION_DOCS.map((file) => path.join(REPOSITORY_ROOT, file)),
    ...references,
  ];
}

test("plugin package tests pass without repository-level files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-isolated-package-"));
  const isolatedPlugin = path.join(temp, "no-swipe");
  try {
    await fs.cp(PLUGIN_ROOT, isolatedPlugin, { recursive: true });
    await execFileAsync(process.execPath, ["--test"], { cwd: isolatedPlugin });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("all release version surfaces stay paired", () => {
  const state = assertVersionState(REPOSITORY_ROOT);
  assert.equal(state.ok, true);
  assert.equal(state.surfaceCount, 10);
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
