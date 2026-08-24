#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const MARKETPLACE_PATH = path.join(ROOT, ".agents/plugins/marketplace.json");
const PLUGIN_JSON_PATH = path.join(ROOT, "plugins/no-swipe/.codex-plugin/plugin.json");
const PLUGIN_PACKAGE_PATH = path.join(ROOT, "plugins/no-swipe/package.json");
const CLI_VERSION_PATH = path.join(ROOT, "plugins/no-swipe/config/cli-version.json");
const SUPABASE_JSON_PATH = path.join(ROOT, "plugins/no-swipe/config/supabase.json");
const CLI_PACKAGE_PATH = path.join(ROOT, "cli/package.json");
const CLOUD_PATH = path.join(ROOT, "cli/src/cloud.ts");
const ARTIFACTS = [
  "manifest.json",
  "no-swipe-darwin-arm64.gz",
  "no-swipe-darwin-x64.gz",
  "no-swipe-windows-x64.exe.gz",
];

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string[], cwd = ROOT) {
  const proc = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} failed`);
}

function captured(command: string[], cwd = ROOT) {
  const proc = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  return stdout.trim();
}

function stamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function bumpVersions(version: string) {
  const marketplace = readJson(MARKETPLACE_PATH);
  marketplace.version = version;
  if (Array.isArray(marketplace.plugins) && marketplace.plugins[0]) marketplace.plugins[0].version = version;
  writeJson(MARKETPLACE_PATH, marketplace);

  const plugin = readJson(PLUGIN_JSON_PATH);
  plugin.version = `${version}+codex.${stamp()}`;
  writeJson(PLUGIN_JSON_PATH, plugin);

  const pluginPackage = readJson(PLUGIN_PACKAGE_PATH);
  pluginPackage.version = version;
  writeJson(PLUGIN_PACKAGE_PATH, pluginPackage);

  writeJson(CLI_VERSION_PATH, { version });

  const supabase = readJson(SUPABASE_JSON_PATH);
  supabase.plugin_version = version;
  writeJson(SUPABASE_JSON_PATH, supabase);

  const cliPackage = readJson(CLI_PACKAGE_PATH);
  cliPackage.version = version;
  writeJson(CLI_PACKAGE_PATH, cliPackage);

  const cloud = readFileSync(CLOUD_PATH, "utf8");
  const next = cloud.replace(/plugin_version: "[^"]+"/, `plugin_version: "${version}"`);
  if (next === cloud) throw new Error("failed to bump cli/src/cloud.ts plugin_version");
  writeFileSync(CLOUD_PATH, next);
}

function supabaseWorkdir() {
  const parent = path.resolve(ROOT, "..");
  if (existsSync(path.join(parent, "supabase/config.toml"))) return parent;
  if (existsSync(path.join(ROOT, "supabase/config.toml")) && existsSync(path.join(ROOT, "supabase/.temp"))) return ROOT;
  throw new Error("cannot find a linked supabase workdir; pass --supabase-workdir");
}

function upload(version: string, workdir: string) {
  const dist = path.join(ROOT, "cli/dist", version);
  for (const name of ARTIFACTS) {
    const local = path.join(dist, name);
    if (!existsSync(local)) throw new Error(`missing artifact ${local}`);
    run([
      "supabase", "storage", "cp", "--experimental", "--linked",
      "--workdir", workdir,
      "--cache-control", "max-age=31536000",
      local,
      `ss:///no-swipe-releases/${version}/${name}`,
    ]);
  }
}

function commitAndMaybePush(version: string, push: boolean) {
  run(["git", "add",
    ".agents/plugins/marketplace.json",
    "plugins/no-swipe/.codex-plugin/plugin.json",
    "plugins/no-swipe/package.json",
    "plugins/no-swipe/config/cli-version.json",
    "plugins/no-swipe/config/supabase.json",
    "cli/package.json",
    "cli/src/cloud.ts",
  ]);
  const staged = captured(["git", "diff", "--cached", "--name-only"]);
  if (!staged) throw new Error("nothing staged for release commit");
  run(["git", "commit", "-m", `chore: release No Swipe ${version}\n\nBump plugin.json and marketplace.json together, pin cli-version.json, and publish the matching Storage objects.`]);
  if (push) run(["git", "push", "origin", "HEAD"]);
}

function usage() {
  console.log("usage: bun scripts/release.ts <x.y.z> [--push] [--skip-tests] [--skip-build] [--skip-upload] [--skip-commit] [--supabase-workdir <path>]");
}

const args = process.argv.slice(2);
const version = args.find((arg) => !arg.startsWith("--"));
if (!version || args.includes("--help") || !/^\d+\.\d+\.\d+$/.test(version)) {
  usage();
  process.exit(version ? 1 : 0);
}

const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const workdirIndex = args.indexOf("--supabase-workdir");
const workdir = workdirIndex >= 0 ? path.resolve(args[workdirIndex + 1]) : supabaseWorkdir();

const current = readJson(CLI_VERSION_PATH).version;
if (current === version) throw new Error(`${version} is already the current cli-version`);

bumpVersions(version);
if (!flags.has("--skip-tests")) {
  run(["bun", "test"], path.join(ROOT, "cli"));
  run(["node", "--test"], path.join(ROOT, "plugins/no-swipe"));
}
if (!flags.has("--skip-build")) run(["bun", "scripts/build.ts"], path.join(ROOT, "cli"));
if (!flags.has("--skip-upload")) upload(version, workdir);
if (!flags.has("--skip-commit")) commitAndMaybePush(version, flags.has("--push"));
console.log(JSON.stringify({ ok: true, version, pushed: flags.has("--push") }, null, 2));
