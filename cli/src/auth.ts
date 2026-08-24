import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { functionUrl, hostFingerprint, loadCloudConfig } from "./cloud.ts";
import { CONFIG_DIR, CREDENTIALS_PATH } from "./paths.ts";

export type Credentials = {
  device_token: string;
  user_id?: string;
  workbench_url: string;
  host_fingerprint: string;
};

export function readCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeCredentials(value: Credentials) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_DIR, 0o700);
  chmodSync(CREDENTIALS_PATH, 0o600);
}

export async function authLogin() {
  const config = loadCloudConfig();
  const start = await fetch(functionUrl(config, "pair-start"), {
    method: "POST",
    headers: { apikey: config.publishable_key, "content-type": "application/json" },
    body: "{}",
  });
  const started = await start.json();
  if (!start.ok) throw new Error(started.error || "pair-start failed");
  const pairUrl = `${config.workbench_url}/pair?code=${encodeURIComponent(started.code)}`;
  return {
    status: "pending",
    code: started.code,
    device_secret: started.device_secret,
    pair_url: pairUrl,
    poll: () => pollPairing(started.code, started.device_secret),
  };
}

export async function pollPairing(code: string, deviceSecret: string) {
  const config = loadCloudConfig();
  const response = await fetch(functionUrl(config, "pair-poll"), {
    method: "POST",
    headers: { apikey: config.publishable_key, "content-type": "application/json" },
    body: JSON.stringify({
      code,
      device_secret: deviceSecret,
      host_fingerprint: hostFingerprint(),
    }),
  });
  const payload = await response.json();
  if (response.status === 202) return { status: "pending", code };
  if (!response.ok) throw new Error(payload.error || "pair-poll failed");
  writeCredentials({
    device_token: payload.device_token,
    user_id: payload.user_id,
    workbench_url: config.workbench_url,
    host_fingerprint: hostFingerprint(),
  });
  return { status: "approved", user_id: payload.user_id, credentials_path: CREDENTIALS_PATH };
}

export async function authStatus() {
  const credentials = readCredentials();
  if (!credentials?.device_token) return { connected: false, reason: "missing_credentials" };
  const config = loadCloudConfig();
  const response = await fetch(functionUrl(config, "ingest"), {
    method: "POST",
    headers: {
      apikey: config.publishable_key,
      authorization: `Bearer ${credentials.device_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contract_version: 2,
      session_id: "auth-status",
      client: { plugin_version: config.plugin_version },
      started_at: new Date().toISOString(),
      records: [],
    }),
  });
  if (response.status === 401) return { connected: false, reason: "invalid_or_revoked" };
  return { connected: response.ok || response.status === 400, user_id: credentials.user_id };
}

export function authLogout() {
  rmSync(CREDENTIALS_PATH, { force: true });
  return { ok: true };
}
