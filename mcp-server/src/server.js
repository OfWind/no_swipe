import { loadConfig } from "./config.js";
import { createSupabaseTokenVerifier } from "./auth.js";
import { createIngestClient } from "./ingest.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp({
  config,
  tokenVerifier: createSupabaseTokenVerifier(config),
  ingestClient: createIngestClient(config),
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "server_started", port: config.port, mcp_url: config.mcpUrl }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: "server_stopping", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
