import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { createSupabaseTokenVerifier } from "../src/auth.js";
import { recordSchema } from "../src/mcp.js";

const config = {
  port: 0,
  publicBaseUrl: "http://127.0.0.1",
  mcpUrl: "http://127.0.0.1/mcp",
  supabaseUrl: "https://example.supabase.co",
  supabaseIssuer: "https://example.supabase.co/auth/v1",
  publishableKey: "sb_publishable_test",
  ingestUrl: "https://example.supabase.co/functions/v1/ingest",
  maxBodyBytes: 500_000,
  requireOAuthClient: true,
};

const validRecord = {
  record_id: "record-1",
  observed_at: "2026-08-14T04:00:00Z",
  feed_index: 1,
  is_relevant: true,
  decision: "keep",
  action: "watch_then_next",
};
const validBatch = {
  contract_version: 2,
  session_id: "session-1",
  client: { plugin_version: "0.2.0" },
  task_config: {},
  started_at: "2026-08-14T04:00:00Z",
  finished_at: null,
  stats: {},
  heartbeat: {},
  records: [validRecord],
};

let httpServer;
let baseUrl;
let captured;

function unsignedJwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

before(async () => {
  const tokenVerifier = {
    async verifyAccessToken(token) {
      if (token !== "valid-token") throw new Error("invalid token");
      return {
        token,
        clientId: "chatgpt-test",
        scopes: ["openid", "email", "profile"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { userId: "user-1", email: "user@example.com" },
      };
    },
  };
  const ingestClient = {
    async ingest(token, body) {
      captured = { token, body };
      return { accepted: ["record-1"], duplicated: [], rejected: [] };
    },
  };
  const app = createApp({ config, tokenVerifier, ingestClient });
  httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
});

test("publishes OAuth protected resource metadata", async () => {
  const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resource, config.mcpUrl);
  assert.deepEqual(body.authorization_servers, [config.supabaseIssuer]);
});

test("serves the OAuth connection management route", async () => {
  const response = await fetch(`${baseUrl}/account`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /No Swipe/);
});

test("rejects MCP requests without authorization and advertises discovery", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /oauth-protected-resource\/mcp/);
});

test("authorized MCP client can list tools and upload an idempotent batch", async () => {
  const client = new Client({ name: "no-swipe-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: "Bearer valid-token" } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "ingest_observation_batch"));
  const result = await client.callTool({ name: "ingest_observation_batch", arguments: validBatch });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.accepted, ["record-1"]);
  assert.equal(captured.token, "valid-token");
  assert.deepEqual(captured.body, validBatch);
  await client.close();
});

test("MCP timestamp schema accepts explicit timezones and rejects bare local time", () => {
  for (const observed_at of [
    "2026-08-14T04:00:00Z",
    "2026-08-14T09:30:00+05:30",
    "2026-08-13T23:00:00-05:00",
  ]) {
    assert.equal(recordSchema.safeParse({ ...validRecord, observed_at }).success, true);
  }
  assert.equal(recordSchema.safeParse({
    ...validRecord,
    observed_at: "2026-08-14T12:00:00",
  }).success, false);
});

test("Supabase verifier requires OAuth client and authenticated audience", async () => {
  const supabase = {
    auth: {
      async getUser() {
        return {
          data: {
            user: {
              id: "user-1",
              email: "user@example.com",
              email_confirmed_at: "2026-08-14T00:00:00Z",
            },
          },
          error: null,
        };
      },
    },
  };
  const verifier = createSupabaseTokenVerifier(config, { supabase });
  const baseClaims = {
    iss: config.supabaseIssuer,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    client_id: "oauth-client-1",
  };
  const verified = await verifier.verifyAccessToken(unsignedJwt(baseClaims));
  assert.equal(verified.clientId, "oauth-client-1");

  await assert.rejects(
    verifier.verifyAccessToken(unsignedJwt({ ...baseClaims, client_id: undefined })),
    /Install-time OAuth authorization is required/,
  );
  await assert.rejects(
    verifier.verifyAccessToken(unsignedJwt({ ...baseClaims, aud: "wrong" })),
    /Unexpected token audience/,
  );
});
