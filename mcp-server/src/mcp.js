import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { IngestError } from "./ingest.js";

const timestamp = z.string().datetime({ offset: true });
const recordSchema = z.object({
  record_id: z.string().min(1).max(128),
  observed_at: timestamp,
  feed_index: z.number().int().positive(),
  is_relevant: z.boolean(),
  decision: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  dwell_seconds: z.number().nonnegative().nullable().optional(),
  interest_score: z.number().finite().nullable().optional(),
}).passthrough();

const batchSchema = {
  contract_version: z.literal(2),
  session_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  client: z.object({
    plugin_version: z.string().min(1).max(64),
    host_fingerprint: z.string().max(128).optional(),
  }).passthrough(),
  task_config: z.record(z.string(), z.unknown()).default({}),
  started_at: timestamp,
  finished_at: timestamp.nullable().optional(),
  stats: z.record(z.string(), z.unknown()).default({}),
  heartbeat: z.record(z.string(), z.unknown()).default({}),
  records: z.array(recordSchema).max(100),
};

function failureResult(error) {
  const message = error instanceof IngestError ? error.message : "Upload failed";
  return {
    isError: true,
    content: [{ type: "text", text: `No Swipe upload failed: ${message}` }],
  };
}

export function createNoSwipeMcpServer({ authInfo, ingestClient }) {
  const server = new McpServer(
    { name: "no-swipe", version: "0.1.0" },
    {
      instructions:
        "Upload every locally queued No Swipe observation with ingest_observation_batch, then acknowledge only IDs returned as accepted or duplicated. Never include credentials in records.",
    },
  );

  server.registerTool(
    "get_upload_status",
    {
      title: "Check No Swipe upload connection",
      description: "Verify that the current user authorized No Swipe data uploads.",
      inputSchema: {},
      outputSchema: { connected: z.boolean(), user_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const result = { connected: true, user_id: String(authInfo.extra?.userId ?? "") };
      return {
        structuredContent: result,
        content: [{ type: "text", text: "No Swipe upload connection is authorized." }],
      };
    },
  );

  server.registerTool(
    "ingest_observation_batch",
    {
      title: "Upload No Swipe observations",
      description:
        "Upload one durable No Swipe collector batch to Supabase. The operation is idempotent by user, session, and record ID.",
      inputSchema: batchSchema,
      outputSchema: {
        accepted: z.array(z.string()),
        duplicated: z.array(z.string()),
        rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (body) => {
      try {
        const response = await ingestClient.ingest(authInfo.token, body);
        const result = {
          accepted: Array.isArray(response.accepted) ? response.accepted.map(String) : [],
          duplicated: Array.isArray(response.duplicated) ? response.duplicated.map(String) : [],
          rejected: Array.isArray(response.rejected) ? response.rejected : [],
        };
        return {
          structuredContent: result,
          content: [{
            type: "text",
            text: `Uploaded ${result.accepted.length}; ${result.duplicated.length} duplicates; ${result.rejected.length} rejected.`,
          }],
        };
      } catch (error) {
        return failureResult(error);
      }
    },
  );

  return server;
}

export { batchSchema, recordSchema };
