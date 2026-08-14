const DEFAULT_MAX_BODY_BYTES = 500_000;

function requiredUrl(name, value) {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`${name} must use HTTPS outside localhost`);
  }
  return url.href.replace(/\/$/, "");
}

export function loadConfig(env = process.env) {
  const publicBaseUrl = requiredUrl("PUBLIC_BASE_URL", env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000");
  const supabaseUrl = requiredUrl("SUPABASE_URL", env.SUPABASE_URL);
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!publishableKey?.startsWith("sb_publishable_") && !publishableKey?.startsWith("eyJ")) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY is missing or invalid");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");

  const maxBodyBytes = Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("MAX_BODY_BYTES is invalid");

  return Object.freeze({
    port,
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl}/mcp`,
    supabaseUrl,
    supabaseIssuer: `${supabaseUrl}/auth/v1`,
    publishableKey,
    ingestUrl: `${supabaseUrl}/functions/v1/ingest`,
    maxBodyBytes,
    requireOAuthClient: env.REQUIRE_OAUTH_CLIENT !== "false",
  });
}
