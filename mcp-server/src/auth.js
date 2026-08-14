import { createClient } from "@supabase/supabase-js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new InvalidTokenError("Malformed access token");
  }
}

function tokenScopes(claims) {
  if (typeof claims.scope === "string") return claims.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(claims.scopes)) return claims.scopes.filter((value) => typeof value === "string");
  return [];
}

export function createSupabaseTokenVerifier(config, options = {}) {
  const supabase = options.supabase ?? createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async verifyAccessToken(token) {
      const claims = decodeJwtPayload(token);
      const { data, error } = await supabase.auth.getUser(token);
      const user = data?.user;
      if (error || !user?.id) throw new InvalidTokenError("Invalid or expired Supabase session");
      if (!user.email || !(user.email_confirmed_at || user.confirmed_at)) {
        throw new InvalidTokenError("A verified email account is required");
      }
      if (claims.iss !== config.supabaseIssuer) throw new InvalidTokenError("Unexpected token issuer");
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes("authenticated")) throw new InvalidTokenError("Unexpected token audience");
      if (config.requireOAuthClient && typeof claims.client_id !== "string") {
        throw new InvalidTokenError("Install-time OAuth authorization is required");
      }

      return {
        token,
        clientId: typeof claims.client_id === "string" ? claims.client_id : "supabase-session",
        scopes: tokenScopes(claims),
        expiresAt: Number(claims.exp),
        extra: { userId: user.id, email: user.email },
      };
    },
  };
}
