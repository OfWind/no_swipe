import { existsSync } from "node:fs";
import path from "node:path";
import { authStatus, readCredentials } from "./auth.ts";
import { loadCloudConfig } from "./cloud.ts";
import { listAccountProfiles, readAccountIdentity } from "./config.mjs";
import { DATA_DIR } from "./paths.ts";

export async function up(dataDir = DATA_DIR) {
  const config = loadCloudConfig();
  let auth: { connected: boolean; [key: string]: unknown };
  try {
    auth = await authStatus() as { connected: boolean; [key: string]: unknown };
  } catch (error) {
    auth = {
      connected: false,
      reason: "network_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let accounts: unknown[] = [];
  try {
    const profiles = await listAccountProfiles({ dataDir }) as Array<Record<string, unknown>>;
    accounts = await Promise.all(profiles.map(async (profile) => ({
      account_ref: profile.account_ref,
      profile_id: profile.profile_id,
      revision: profile.revision,
      name: profile.name,
      douyin_nickname:
        (await readAccountIdentity(String(profile.account_ref), { dataDir }))?.douyin_nickname ?? null,
    })));
  } catch {
    accounts = [];
  }
  // Older releases stored bindings in a cwd-relative .no-swipe directory;
  // surface it so a session can explicitly reuse that copy via --data-dir.
  const legacyDir = path.resolve(".no-swipe");
  const legacyWorkspaceData =
    path.resolve(dataDir) !== legacyDir && existsSync(path.join(legacyDir, "accounts"))
      ? legacyDir
      : null;

  return {
    ok: true,
    plugin_version: config.plugin_version,
    auth,
    next: auth.connected ? "resolve_account" : "auth_login",
    data_dir: path.resolve(dataDir),
    accounts,
    legacy_workspace_data: legacyWorkspaceData,
    workbench_url: readCredentials()?.workbench_url ?? config.workbench_url,
  };
}
