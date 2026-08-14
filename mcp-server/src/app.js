import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createNoSwipeMcpServer } from "./mcp.js";

export function createApp({ config, tokenVerifier, ingestClient }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxBodyBytes }));

  const protectedResource = {
    resource: config.mcpUrl,
    authorization_servers: [config.supabaseIssuer],
    scopes_supported: ["openid", "email", "profile"],
    resource_name: "No Swipe observation upload",
    resource_documentation: `${config.publicBaseUrl}/privacy`,
  };
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl));

  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(protectedResource));
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(protectedResource));
  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "no-swipe-mcp" }));
  app.get("/api/public-config", (_req, res) => {
    res.set("cache-control", "public, max-age=300");
    res.json({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey });
  });

  app.use(express.static(new URL("../public", import.meta.url).pathname, {
    extensions: ["html"],
    maxAge: "1h",
  }));
  for (const path of ["/", "/login", "/oauth/consent", "/privacy", "/terms"]) {
    app.get(path, (_req, res) => res.sendFile(new URL("../public/index.html", import.meta.url).pathname));
  }

  const authMiddleware = requireBearerAuth({
    verifier: tokenVerifier,
    requiredScopes: [],
    resourceMetadataUrl: metadataUrl,
  });

  app.post("/mcp", authMiddleware, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createNoSwipeMcpServer({ authInfo: req.auth, ingestClient });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("mcp_request_failed", error instanceof Error ? error.message : "unknown");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    }
  });
  app.get("/mcp", authMiddleware, (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
  app.delete("/mcp", authMiddleware, (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    console.error("http_request_failed", error instanceof Error ? error.message : "unknown");
    return res.status(500).json({ error: "internal_server_error" });
  });
  return app;
}
