#!/usr/bin/env bun
import { existsSync } from "node:fs";
import path from "node:path";
import { assertVersionState, setVersion } from "./set-version.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const ARTIFACTS = [
  "manifest.json",
  "no-swipe-darwin-arm64.gz",
  "no-swipe-darwin-x64.gz",
  "no-swipe-windows-x64.exe.gz",
];

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
    "plugins/no-swipe/package-lock.json",
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
  console.log("usage: bun scripts/release.ts <x.y.z> [--push] [--reuse-version] [--skip-tests] [--skip-build] [--skip-upload] [--skip-commit] [--supabase-workdir <path>]");
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

const current = assertVersionState(ROOT).version;
if (current === version && !flags.has("--reuse-version")) {
  throw new Error(`${version} is already current; changed files require the next semantic version. Use --reuse-version only to promote the exact unchanged candidate already tested under this version`);
}
if (current !== version && flags.has("--reuse-version")) {
  throw new Error("--reuse-version requires the requested version to equal the current tested candidate version");
}
if (current !== version) setVersion(version, { root: ROOT });
if (!flags.has("--skip-tests")) {
  run(["bun", "test"], path.join(ROOT, "cli"));
  run(["node", "--test", "scripts/set-version.test.mjs", "scripts/repository-contract.test.mjs"], ROOT);
  run(["node", "--test"], path.join(ROOT, "plugins/no-swipe"));
}
if (!flags.has("--skip-build")) run(["bun", "scripts/build.ts"], path.join(ROOT, "cli"));
if (!flags.has("--skip-upload")) upload(version, workdir);
if (!flags.has("--skip-commit")) {
  try {
    commitAndMaybePush(version, flags.has("--push"));
  } catch (error) {
    if (!flags.has("--reuse-version") || !String(error instanceof Error ? error.message : error).includes("nothing staged")) {
      throw error;
    }
    if (flags.has("--push")) run(["git", "push", "origin", "HEAD"]);
  }
}
console.log(JSON.stringify({ ok: true, version, reused: current === version, pushed: flags.has("--push") }, null, 2));
