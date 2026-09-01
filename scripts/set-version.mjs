#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/;
const BUILD_STAMP = /^\d{14}$/;

export const VERSION_FILES = Object.freeze({
  marketplace: ".agents/plugins/marketplace.json",
  pluginManifest: "plugins/no-swipe/.codex-plugin/plugin.json",
  pluginPackage: "plugins/no-swipe/package.json",
  pluginPackageLock: "plugins/no-swipe/package-lock.json",
  cliVersion: "plugins/no-swipe/config/cli-version.json",
  supabase: "plugins/no-swipe/config/supabase.json",
  cliPackage: "cli/package.json",
  cloud: "cli/src/cloud.ts",
});

function validateVersion(version) {
  if (!SEMANTIC_VERSION.test(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}; expected x.y.z`);
  }
}

function versionPath(root, key) {
  return path.join(root, VERSION_FILES[key]);
}

function parseJson(source, file) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encodeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function noSwipeMarketplaceEntry(marketplace) {
  const entry = marketplace.plugins?.find?.((plugin) => plugin?.name === "no-swipe");
  if (!entry) throw new Error("marketplace does not contain the no-swipe plugin entry");
  return entry;
}

function cloudVersion(source) {
  const matches = [...source.matchAll(/\bplugin_version:\s*"([^"]+)"/g)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one plugin_version in ${VERSION_FILES.cloud}; found ${matches.length}`);
  }
  return matches[0][1];
}

export function createBuildStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readSources(root) {
  return Object.fromEntries(Object.keys(VERSION_FILES).map((key) => [
    key,
    readFileSync(versionPath(root, key), "utf8"),
  ]));
}

function parseSources(sources) {
  const marketplace = parseJson(sources.marketplace, VERSION_FILES.marketplace);
  const pluginManifest = parseJson(sources.pluginManifest, VERSION_FILES.pluginManifest);
  const pluginPackage = parseJson(sources.pluginPackage, VERSION_FILES.pluginPackage);
  const pluginPackageLock = parseJson(sources.pluginPackageLock, VERSION_FILES.pluginPackageLock);
  const cliVersion = parseJson(sources.cliVersion, VERSION_FILES.cliVersion);
  const supabase = parseJson(sources.supabase, VERSION_FILES.supabase);
  const cliPackage = parseJson(sources.cliPackage, VERSION_FILES.cliPackage);
  const marketplacePlugin = noSwipeMarketplaceEntry(marketplace);

  if (!pluginPackageLock.packages?.[""]) {
    throw new Error(`${VERSION_FILES.pluginPackageLock} does not contain the root package entry`);
  }

  return {
    marketplace,
    marketplacePlugin,
    pluginManifest,
    pluginPackage,
    pluginPackageLock,
    cliVersion,
    supabase,
    cliPackage,
    cloudVersion: cloudVersion(sources.cloud),
  };
}

export function readVersionState(root = DEFAULT_ROOT) {
  const parsed = parseSources(readSources(root));
  const pluginBuild = parsed.pluginManifest.version;
  const pluginBase = typeof pluginBuild === "string" ? pluginBuild.split("+", 1)[0] : pluginBuild;

  return {
    pluginBuild,
    versions: {
      marketplace: parsed.marketplace.version,
      marketplacePlugin: parsed.marketplacePlugin.version,
      pluginManifest: pluginBase,
      pluginPackage: parsed.pluginPackage.version,
      pluginPackageLock: parsed.pluginPackageLock.version,
      pluginPackageLockRoot: parsed.pluginPackageLock.packages[""].version,
      cliVersion: parsed.cliVersion.version,
      supabase: parsed.supabase.plugin_version,
      cliPackage: parsed.cliPackage.version,
      cloud: parsed.cloudVersion,
    },
  };
}

export function assertVersionState(root = DEFAULT_ROOT, expectedVersion) {
  if (expectedVersion !== undefined) validateVersion(expectedVersion);
  const state = readVersionState(root);
  const expected = expectedVersion ?? state.versions.cliVersion;
  validateVersion(expected);

  const mismatches = Object.entries(state.versions)
    .filter(([, version]) => version !== expected)
    .map(([surface, version]) => `${surface}=${JSON.stringify(version)}`);
  const buildPattern = new RegExp(`^${expected.replaceAll(".", "\\.")}\\+codex\\.\\d{14}$`);
  if (!buildPattern.test(state.pluginBuild)) {
    mismatches.push(`pluginBuild=${JSON.stringify(state.pluginBuild)}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`version surfaces do not match ${expected}: ${mismatches.join(", ")}`);
  }

  return {
    ok: true,
    version: expected,
    pluginBuild: state.pluginBuild,
    surfaceCount: Object.keys(state.versions).length,
  };
}

export function setVersion(version, { root = DEFAULT_ROOT, buildStamp = createBuildStamp() } = {}) {
  validateVersion(version);
  if (!BUILD_STAMP.test(buildStamp)) {
    throw new Error(`invalid build stamp ${JSON.stringify(buildStamp)}; expected YYYYMMDDhhmmss`);
  }

  const originals = readSources(root);
  const parsed = parseSources(originals);

  parsed.marketplace.version = version;
  parsed.marketplacePlugin.version = version;
  parsed.pluginManifest.version = `${version}+codex.${buildStamp}`;
  parsed.pluginPackage.version = version;
  parsed.pluginPackageLock.version = version;
  parsed.pluginPackageLock.packages[""].version = version;
  parsed.cliVersion.version = version;
  parsed.supabase.plugin_version = version;
  parsed.cliPackage.version = version;

  const cloud = originals.cloud.replace(
    /\bplugin_version:\s*"[^"]+"/,
    `plugin_version: "${version}"`,
  );
  cloudVersion(cloud);

  const updates = {
    marketplace: encodeJson(parsed.marketplace),
    pluginManifest: encodeJson(parsed.pluginManifest),
    pluginPackage: encodeJson(parsed.pluginPackage),
    pluginPackageLock: encodeJson(parsed.pluginPackageLock),
    cliVersion: encodeJson(parsed.cliVersion),
    supabase: encodeJson(parsed.supabase),
    cliPackage: encodeJson(parsed.cliPackage),
    cloud,
  };

  const written = [];
  try {
    for (const [key, source] of Object.entries(updates)) {
      writeFileSync(versionPath(root, key), source);
      written.push(key);
    }
    return assertVersionState(root, version);
  } catch (error) {
    for (const key of written.reverse()) {
      writeFileSync(versionPath(root, key), originals[key]);
    }
    throw error;
  }
}

function usage() {
  console.log("usage: ./scripts/set-version.mjs <x.y.z> | ./scripts/set-version.mjs --check [x.y.z]");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const result = args[0] === "--check"
    ? assertVersionState(DEFAULT_ROOT, args[1])
    : args.length === 1
      ? setVersion(args[0])
      : null;
  if (!result) {
    usage();
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
