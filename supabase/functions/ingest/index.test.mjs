import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { handleRequest } from "./index.ts";

const originalDeno = globalThis.Deno;
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.Deno = {
    env: {
      get(name) {
        return {
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_ANON_KEY: "sb_publishable_test",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        }[name];
      },
    },
  };
});

after(() => {
  globalThis.Deno = originalDeno;
  globalThis.fetch = originalFetch;
});

function batch(timestamp) {
  return {
    contract_version: 2,
    session_id: "session-1",
    client: { plugin_version: "test" },
    task_config: {},
    started_at: timestamp,
    finished_at: timestamp,
    stats: {},
    heartbeat: {},
    records: [{
      record_id: "record-1",
      observed_at: timestamp,
      feed_index: 1,
      is_relevant: true,
      decision: "keep",
      action: "watch_then_next",
    }],
  };
}

async function invoke(timestamp) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/v1/user")) {
      return Response.json({ id: "user-1", email: "user@example.com" });
    }
    const rpcBody = JSON.parse(init.body);
    return Response.json({
      accepted: rpcBody.p_records.map((record) => record.record_id),
      duplicated: [],
    });
  };
  const response = await handleRequest(new Request("https://example.supabase.co/functions/v1/ingest", {
    method: "POST",
    headers: {
      authorization: "Bearer user-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(batch(timestamp)),
  }));
  return { response, calls };
}

test("accepts RFC 3339 timestamps with UTC or explicit offsets", async () => {
  for (const timestamp of [
    "2026-08-14T04:00:00Z",
    "2026-08-14T09:30:00+05:30",
    "2026-08-13T23:00:00-05:00",
  ]) {
    const { response, calls } = await invoke(timestamp);
    assert.equal(response.status, 200, `${timestamp} should be accepted`);
    assert.equal(calls.length, 2, `${timestamp} should reach the database RPC`);
    assert.deepEqual(await response.json(), {
      accepted: ["record-1"],
      duplicated: [],
      rejected: [],
    });
  }
});

test("rejects a timestamp without timezone information", async () => {
  const { response, calls } = await invoke("2026-08-14T12:00:00");
  assert.equal(response.status, 400);
  assert.equal(calls.length, 1, "a timezone-less request must not reach the database RPC");
  assert.deepEqual(await response.json(), {
    error: "invalid_started_at",
    reason: "must include a UTC designator or numeric timezone offset",
  });
});
