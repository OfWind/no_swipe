import {
  ConfigValidationError,
  bindAccountProfile,
  computeConfigHash,
  confirmRunConfig,
  createProfileSnapshot,
  listAccountProfiles,
  materializeOnboardingPreset,
  readJson,
  resolveAccountProfile,
  updateAccountProfile,
  validateAccountProfile,
  validateOnboardingPreset,
  validateRunConfig,
  writeJsonAtomic,
} from "./config.mjs";

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runConfig(args: string[]) {
  const [resource, command, filePath] = args;
  const fileRequired = !(resource === "profile" && command === "list");
  if (!resource || !command || (fileRequired && !filePath)) {
    throw new Error("no-swipe config <profile|preset|run> <command> [file]");
  }
  const dataDir = option(args, "--data-dir") || ".no-swipe";
  const value = resource === "profile" && ["resolve", "list"].includes(command) ? null : await readJson(filePath);
  if (resource === "profile" && command === "validate") {
    validateAccountProfile(value);
    return { ok: true, kind: "AccountProfile", file: filePath };
  }
  if (resource === "profile" && command === "snapshot") return createProfileSnapshot(value);
  if (resource === "profile" && command === "bind") {
    const result = await bindAccountProfile(value, { dataDir });
    return { ok: true, account_ref: value.account_ref, profile_id: value.profile_id, revision: value.revision, current: result.currentPath };
  }
  if (resource === "profile" && command === "list") {
    const profiles = await listAccountProfiles({ dataDir });
    return { ok: true, count: profiles.length, profiles };
  }
  if (resource === "profile" && command === "resolve") {
    const profile = await resolveAccountProfile(filePath, { dataDir });
    return { ok: true, found: Boolean(profile), profile };
  }
  if (resource === "profile" && command === "update") {
    const result = await updateAccountProfile(value, { dataDir });
    return { ok: true, account_ref: value.account_ref, profile_id: value.profile_id, revision: value.revision, current: result.currentPath };
  }
  if (resource === "preset" && command === "validate") {
    validateOnboardingPreset(value);
    return { ok: true, kind: "OnboardingPreset", preset_id: value.preset_id };
  }
  if (resource === "preset" && command === "materialize") {
    const profileInputPath = option(args, "--profile-input");
    const runInputPath = option(args, "--run-input");
    const revisionOption = option(args, "--revision");
    const materialized = materializeOnboardingPreset(value, {
      accountRef: option(args, "--account-ref"),
      profileId: option(args, "--profile-id"),
      runId: option(args, "--run-id"),
      revision: revisionOption === undefined ? undefined : Number(revisionOption),
      profileMode: option(args, "--profile-mode") || "preset",
      profileInput: profileInputPath ? await readJson(profileInputPath) : undefined,
      runMode: option(args, "--run-mode") || "preset",
      runInput: runInputPath ? await readJson(runInputPath) : undefined,
    });
    const outputDir = option(args, "--output-dir");
    if (outputDir) {
      const profilePath = `${outputDir}/account-profile.json`;
      const runPath = `${outputDir}/run-config.draft.json`;
      await writeJsonAtomic(profilePath, materialized.profile);
      await writeJsonAtomic(runPath, materialized.run_config);
      return { ok: true, preset_id: value.preset_id, application: materialized.application, profile: profilePath, run_config: runPath };
    }
    return materialized;
  }
  if (resource === "run" && command === "validate") {
    validateRunConfig(value, { requireConfirmed: args.includes("--require-confirmed") });
    return { ok: true, kind: "RunConfig", status: value.status, config_hash: value.config_hash || null };
  }
  if (resource === "run" && command === "hash") {
    validateRunConfig(value, { requireConfirmed: value.status === "confirmed" });
    return computeConfigHash(value);
  }
  if (resource === "run" && command === "confirm") {
    const confirmedBy = option(args, "--confirmed-by");
    if (!confirmedBy) throw new Error("run confirm 需要 --confirmed-by");
    const confirmed = confirmRunConfig(value, { confirmedBy });
    const output = option(args, "--output");
    if (output) {
      await writeJsonAtomic(output, confirmed);
      return { ok: true, status: confirmed.status, config_hash: confirmed.config_hash, output };
    }
    return confirmed;
  }
  throw new ConfigValidationError("Command", [{ path: `${resource}.${command}`, message: "unsupported" }]);
}
