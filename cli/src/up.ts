import { authStatus, readCredentials } from "./auth.ts";
import { loadCloudConfig } from "./cloud.ts";
import { listAccountProfiles, readAccountIdentity } from "./config.mjs";

export async function up(dataDir = ".no-swipe") {
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
  return {
    ok: true,
    plugin_version: config.plugin_version,
    auth,
    next: auth.connected ? "resolve_account" : "auth_login",
    accounts,
    workbench_url: readCredentials()?.workbench_url ?? config.workbench_url,
  };
}
