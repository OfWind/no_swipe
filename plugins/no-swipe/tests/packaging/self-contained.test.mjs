import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

test("browser runner imports without external workspace files", async () => {
  const runner = await import(pathToFileURL(path.join(
    ROOT,
    "skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs",
  )));
  assert.equal(typeof runner.createDouyinRunner, "function");
  assert.equal(typeof runner.createTest7Runner, "function");
});

test("product entrypoints do not contain the former test persona or implicit execution flags", async () => {
  const sources = await Promise.all([
    ".codex-plugin/plugin.json",
    "skills/douyin-recommendation-rpa/SKILL.md",
    "skills/douyin-recommendation-rpa/agents/openai.yaml",
    "skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs",
  ].map((file) => fs.readFile(path.join(ROOT, file), "utf8")));
  const combined = sources.join("\n");
  const manifestContent = JSON.stringify(JSON.parse(sources[0]));
  assert.doesNotMatch(combined, /executeFollow\s*:\s*true|executeComments\s*:\s*true/);
  assert.doesNotMatch(manifestContent, /科技|3C|人工智能/i);
  assert.doesNotMatch(sources[2], /科技|3C|人工智能/i);
});

test("bundled schemas and configuration files are valid JSON", async () => {
  const files = (await walk(path.join(ROOT, "config"))).filter((file) => file.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const file of files) JSON.parse(await fs.readFile(file, "utf8"));
});
