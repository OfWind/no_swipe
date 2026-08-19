const MAX_BATCH_SIZE = 100
// Keep well below the hosted gateway range where large requests showed
// unstable timeouts so oversized requests receive a deterministic response.
const MAX_BODY_BYTES = 500_000
const CLIENT_SESSION_KEY = /^[A-Za-z0-9._:-]{1,128}$/
const FORBIDDEN_KEYS = new Set([
  "access_token",
  "authorization",
  "cookie",
  "cookies",
  "password",
  "refresh_token",
  "service_role",
  "secret",
  "set-cookie",
])

type JsonObject = Record<string, unknown>

type RejectedRecord = {
  id: string
  reason: string
}

function jsonResponse(body: JsonObject, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!isObject(value)) return false
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_KEYS.has(key.toLowerCase()) || containsForbiddenKey(child)
  )
}

function validateRecord(record: unknown, seen: Set<string>): string | null {
  if (!isObject(record)) return "record must be a JSON object"

  const recordId = record.record_id
  if (typeof recordId !== "string" || recordId.length < 1 || recordId.length > 128) {
    return "record_id must contain 1-128 characters"
  }
  if (seen.has(recordId)) return "duplicate record_id in request"
  seen.add(recordId)

  if (!Number.isInteger(record.feed_index) || Number(record.feed_index) < 1) {
    return "feed_index must be a positive integer"
  }
  if (typeof record.is_relevant !== "boolean") {
    return "is_relevant must be boolean"
  }
  if (typeof record.decision !== "string" || record.decision.length < 1 || record.decision.length > 128) {
    return "decision must contain 1-128 characters"
  }
  if (typeof record.action !== "string" || record.action.length < 1 || record.action.length > 128) {
    return "action must contain 1-128 characters"
  }
  if (record.dwell_seconds !== null && record.dwell_seconds !== undefined &&
      (typeof record.dwell_seconds !== "number" || !Number.isFinite(record.dwell_seconds) || record.dwell_seconds < 0)) {
    return "dwell_seconds must be a non-negative number or null"
  }
  if (record.interest_score !== null && record.interest_score !== undefined &&
      (typeof record.interest_score !== "number" || !Number.isFinite(record.interest_score))) {
    return "interest_score must be a finite number or null"
  }
  if (containsForbiddenKey(record)) {
    return "record contains a forbidden credential field"
  }
  return null
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { message: text.slice(0, 500) }
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405)
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "payload_too_large" }, 413)
  }

  const authorization = req.headers.get("authorization") ?? ""
  if (!authorization.startsWith("Bearer ")) {
    return jsonResponse({ error: "missing_authorization" }, 401)
  }

  let rawBody: ArrayBuffer
  try {
    rawBody = await req.arrayBuffer()
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400)
  }
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "payload_too_large" }, 413)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("ingest is missing required Supabase environment variables")
    return jsonResponse({ error: "server_misconfigured" }, 500)
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      authorization,
    },
  })
  const userPayload = await parseJson(userResponse)
  if (!userResponse.ok || !isObject(userPayload) || typeof userPayload.id !== "string") {
    return jsonResponse({ error: "invalid_session" }, 401)
  }
  if (typeof userPayload.email !== "string" || userPayload.email.length < 3) {
    return jsonResponse({ error: "verified_email_required" }, 403)
  }

  let body: unknown
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody)
    body = JSON.parse(bodyText)
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400)
  }
  if (!isObject(body)) return jsonResponse({ error: "body_must_be_object" }, 400)
  if (body.contract_version !== 2) {
    return jsonResponse({ error: "unsupported_contract_version", supported: [2] }, 400)
  }
  if (typeof body.session_id !== "string" || !CLIENT_SESSION_KEY.test(body.session_id)) {
    return jsonResponse({ error: "invalid_session_id" }, 400)
  }
  if (!isObject(body.client) ||
      typeof body.client.plugin_version !== "string" ||
      body.client.plugin_version.length < 1 ||
      body.client.plugin_version.length > 64) {
    return jsonResponse({ error: "invalid_client" }, 400)
  }
  if (typeof body.started_at !== "string" || body.started_at.length < 1) {
    return jsonResponse({ error: "invalid_started_at" }, 400)
  }
  if (!Array.isArray(body.records) || body.records.length > MAX_BATCH_SIZE) {
    return jsonResponse({ error: "records_must_be_array", max_batch_size: MAX_BATCH_SIZE }, 400)
  }
  if (containsForbiddenKey(body.client) || containsForbiddenKey(body.task_config) ||
      containsForbiddenKey(body.stats) || containsForbiddenKey(body.heartbeat)) {
    return jsonResponse({ error: "forbidden_credential_field" }, 400)
  }

  const seen = new Set<string>()
  const valid: JsonObject[] = []
  const rejected: RejectedRecord[] = []
  for (const item of body.records) {
    const fallbackId = isObject(item) && typeof item.record_id === "string" ? item.record_id : ""
    const reason = validateRecord(item, seen)
    if (reason) rejected.push({ id: fallbackId, reason })
    else valid.push(item as JsonObject)
  }

  const rpcResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/ingest_observation_batch`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_user_id: userPayload.id,
      p_contract_version: body.contract_version,
      p_client_session_key: body.session_id,
      p_plugin_version: body.client.plugin_version,
      p_task_config: isObject(body.task_config) ? body.task_config : {},
      p_started_at: body.started_at,
      p_finished_at: body.finished_at ?? null,
      p_stats: isObject(body.stats) ? body.stats : {},
      p_records: valid,
      p_heartbeat: isObject(body.heartbeat) ? body.heartbeat : {},
    }),
  })
  const rpcPayload = await parseJson(rpcResponse)
  if (!rpcResponse.ok || !isObject(rpcPayload)) {
    console.error("ingest database call failed", rpcResponse.status)
    return jsonResponse({ error: "database_write_failed" }, 500)
  }

  return jsonResponse({
    accepted: Array.isArray(rpcPayload.accepted) ? rpcPayload.accepted : [],
    duplicated: Array.isArray(rpcPayload.duplicated) ? rpcPayload.duplicated : [],
    rejected,
  })
}

if (import.meta.main) Deno.serve(handleRequest)
