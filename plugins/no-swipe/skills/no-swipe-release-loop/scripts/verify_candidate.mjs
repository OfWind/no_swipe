#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_NAMES = new Set([".DS_Store", "node_modules"]);

function usage() {
  return "usage: node verify_candidate.mjs --source <plugin-root> --candidate <plugin-root> [--installed <plugin-root>]";
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--source", "--candidate", "--installed"].includes(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values[key.slice(2)] = path.resolve(value);
    index += 1;
  }
  if (!values.source || !values.candidate) throw new Error(usage());
  return values;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function metadata(root) {
  const manifest = await readJson(path.join(root, ".codex-plugin/plugin.json"));
  const packageJson = await readJson(path.join(root, "package.json"));
  const cliVersion = await readJson(path.join(root, "config/cli-version.json"));
  return {
    root,
    plugin_version: manifest.version,
    base_plugin_version: String(manifest.version).split("+", 1)[0],
    package_version: packageJson.version,
    cli_version: cliVersion.version,
  };
}

async function walk(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
    else throw new Error(`unsupported filesystem entry: ${absolute}`);
  }
  return files.sort();
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

async function comparableBytes(root, relative, normalizeBuildVersion) {
  const file = path.join(root, relative);
  if (normalizeBuildVersion && relative === ".codex-plugin/plugin.json") {
    const manifest = await readJson(file);
    manifest.version = String(manifest.version).split("+", 1)[0];
    return Buffer.from(JSON.stringify(stableJson(manifest)));
  }
  return fs.readFile(file);
}

async function hashFile(root, relative, normalizeBuildVersion) {
  const bytes = await comparableBytes(root, relative, normalizeBuildVersion);
  return createHash("sha256").update(bytes).digest("hex");
}

async function compare(leftRoot, rightRoot, { normalizeBuildVersion }) {
  const [leftFiles, rightFiles] = await Promise.all([walk(leftRoot), walk(rightRoot)]);
  const leftSet = new Set(leftFiles);
  const rightSet = new Set(rightFiles);
  const missing = leftFiles.filter((file) => !rightSet.has(file));
  const extra = rightFiles.filter((file) => !leftSet.has(file));
  const shared = leftFiles.filter((file) => rightSet.has(file));
  const mismatched = [];
  for (const relative of shared) {
    const [leftHash, rightHash] = await Promise.all([
      hashFile(leftRoot, relative, normalizeBuildVersion),
      hashFile(rightRoot, relative, normalizeBuildVersion),
    ]);
    if (leftHash !== rightHash) mismatched.push(relative);
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    left_file_count: leftFiles.length,
    right_file_count: rightFiles.length,
    missing,
    extra,
    mismatched,
  };
}

function versionsPaired(value) {
  return value.base_plugin_version === value.package_version
    && value.package_version === value.cli_version;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [source, candidate, installed] = await Promise.all([
    metadata(args.source),
    metadata(args.candidate),
    args.installed ? metadata(args.installed) : null,
  ]);
  const sourceToCandidate = await compare(args.source, args.candidate, { normalizeBuildVersion: true });
  const candidateToInstalled = args.installed
    ? await compare(args.candidate, args.installed, { normalizeBuildVersion: false })
    : null;
  const versionChecks = {
    source_paired: versionsPaired(source),
    candidate_paired: versionsPaired(candidate),
    installed_paired: installed ? versionsPaired(installed) : null,
    source_candidate_base_match: source.base_plugin_version === candidate.base_plugin_version,
    candidate_installed_build_match: installed
      ? candidate.plugin_version === installed.plugin_version
      : null,
  };
  const ok = sourceToCandidate.ok
    && (!candidateToInstalled || candidateToInstalled.ok)
    && Object.values(versionChecks).every((value) => value === true || value === null);
  const result = {
    ok,
    source,
    candidate,
    installed,
    version_checks: versionChecks,
    source_to_candidate: sourceToCandidate,
    candidate_to_installed: candidateToInstalled,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
  process.exitCode = 2;
});
