import { authStatus, readCredentials } from "./auth.ts";
import { loadCloudConfig } from "./cloud.ts";
import { listAccountProfiles } from "./config.mjs";

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
    accounts = await listAccountProfiles({ dataDir });
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
