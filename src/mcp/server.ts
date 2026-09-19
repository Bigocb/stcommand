import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TenantRegistry } from "../engine/tenantRegistry.js";
import { registerTools } from "./tools.js";

/**
 * The hosted MCP server, mounted at `/mcp` (see cli/index.ts) — an agent's
 * game-action entry point, per docs/mcp-server-plan.md. Stateless
 * Streamable HTTP: no session held across requests (`sessionIdGenerator:
 * undefined`), a fresh McpServer+transport built per request, same
 * reasoning approvals.ts gives for being DB-polled rather than an
 * in-memory await — this process restarts on every deploy, so nothing here
 * should depend on surviving one.
 *
 * Auth (`req.tenantId`/`req.agentSymbol`) is resolved by `mcpAuth.ts`
 * *before* this router ever runs — mounted ahead of it in cli/index.ts,
 * same position `/api/admin` occupies relative to the cookie-based
 * `resolveTenant`.
 */
export function createMcpRouter(registry: TenantRegistry): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const tenantId = req.tenantId;
    const agentSymbol = req.agentSymbol;
    if (!tenantId || !agentSymbol) {
      // mcpAuth.ts always sets both before this router runs; this is a
      // defensive 401, not a path expected to actually fire.
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "not authenticated" }, id: null });
      return;
    }

    let worker;
    try {
      worker = await registry.getOrCreate(tenantId, agentSymbol);
    } catch (err) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `engine not ready: ${err instanceof Error ? err.message : String(err)}` },
        id: null,
      });
      return;
    }

    const server = new McpServer({ name: "stcommand", version: "1.0.0" });
    registerTools(server, worker);

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("[mcp] request error", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal server error" }, id: null });
      }
    }
  });

  // Streamable HTTP is POST-only in stateless mode (no server-initiated
  // stream to GET, no session to DELETE) — same shape the SDK's own
  // simpleStatelessStreamableHttp.ts example uses.
  router.get("/", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  });
  router.delete("/", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  });

  return router;
}
