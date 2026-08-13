#!/usr/bin/env node
import process from "node:process";
import {
  ConfigValidationError,
  bindAccountProfile,
  computeConfigHash,
  confirmRunConfig,
  createProfileSnapshot,
  readJson,
  resolveAccountProfile,
  updateAccountProfile,
  validateAccountProfile,
  validateRunConfig,
  writeJsonAtomic,
} from "./config.mjs";

function usage() {
  return [
    "No Swipe configuration CLI",
    "",
    "Usage:",
    "  node runtime/src/cli.mjs profile validate <profile.json>",
    "  node runtime/src/cli.mjs profile snapshot <profile.json>",
    "  node runtime/src/cli.mjs profile bind <profile.json> [--data-dir .no-swipe]",
    "  node runtime/src/cli.mjs profile resolve <account-ref> [--data-dir .no-swipe]",
    "  node runtime/src/cli.mjs profile update <profile.json> [--data-dir .no-swipe]",
    "  node runtime/src/cli.mjs run validate <run.json> [--require-confirmed]",
    "  node runtime/src/cli.mjs run hash <run.json>",
    "  node runtime/src/cli.mjs run confirm <run.json> --confirmed-by <actor> [--output <file>]",
  ].join("\n");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args) {
  const [resource, command, filePath] = args;
  if (!resource || !command || !filePath || args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return resource ? 0 : 2;
  }
  const dataDir = option(args, "--data-dir") || ".no-swipe";
  const value = resource === "profile" && command === "resolve" ? null : await readJson(filePath);
  if (resource === "profile" && command === "validate") {
    validateAccountProfile(value);
    process.stdout.write(`${JSON.stringify({ ok: true, kind: "AccountProfile", file: filePath })}\n`);
    return 0;
  }
  if (resource === "profile" && command === "snapshot") {
    process.stdout.write(`${JSON.stringify(createProfileSnapshot(value), null, 2)}\n`);
    return 0;
  }
  if (resource === "profile" && command === "bind") {
    const result = await bindAccountProfile(value, { dataDir });
    process.stdout.write(`${JSON.stringify({ ok: true, account_ref: value.account_ref, profile_id: value.profile_id, revision: value.revision, current: result.currentPath })}\n`);
    return 0;
  }
  if (resource === "profile" && command === "resolve") {
    const profile = await resolveAccountProfile(filePath, { dataDir });
    process.stdout.write(`${JSON.stringify({ ok: true, found: Boolean(profile), profile }, null, 2)}\n`);
    return profile ? 0 : 3;
  }
  if (resource === "profile" && command === "update") {
    const result = await updateAccountProfile(value, { dataDir });
    process.stdout.write(`${JSON.stringify({ ok: true, account_ref: value.account_ref, profile_id: value.profile_id, revision: value.revision, current: result.currentPath })}\n`);
    return 0;
  }
  if (resource === "run" && command === "validate") {
    validateRunConfig(value, { requireConfirmed: args.includes("--require-confirmed") });
    process.stdout.write(`${JSON.stringify({ ok: true, kind: "RunConfig", status: value.status, config_hash: value.config_hash || null })}\n`);
    return 0;
  }
  if (resource === "run" && command === "hash") {
    validateRunConfig(value, { requireConfirmed: value.status === "confirmed" });
    process.stdout.write(`${computeConfigHash(value)}\n`);
    return 0;
  }
  if (resource === "run" && command === "confirm") {
    const confirmedBy = option(args, "--confirmed-by");
    if (!confirmedBy) throw new Error("run confirm 需要 --confirmed-by");
    const confirmed = confirmRunConfig(value, { confirmedBy });
    const output = option(args, "--output");
    if (output) {
      await writeJsonAtomic(output, confirmed);
      process.stdout.write(`${JSON.stringify({ ok: true, status: confirmed.status, config_hash: confirmed.config_hash, output })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(confirmed, null, 2)}\n`);
    }
    return 0;
  }
  throw new Error(`不支持的命令：${resource} ${command}`);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const payload = error instanceof ConfigValidationError
    ? { ok: false, error: error.name, kind: error.kind, issues: error.issues }
    : { ok: false, error: error.name || "Error", message: error.message || String(error) };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
