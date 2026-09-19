import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TenantRegistry } from "../engine/tenantRegistry.js";
import { registerTools } from "./tools.js";

/**
 * Sent back on `initialize` (MCP's `InitializeResult.instructions` field)
 * and surfaced by most MCP clients as a hint to the connecting model — this
 * is player-facing, not engineering-facing. CLAUDE.md's own "lessons
 * learned" sections (e.g. the P&L reporting method) are for a Claude Code
 * session working on *this repo*, which a game-playing agent connected
 * purely over MCP never reads. This is the one message that actually
 * reaches that agent, so it's the place for "how the fleet actually
 * behaves" — the same handful of things a live operator has had to correct
 * a connected agent on more than once. Keep it short and non-technical:
 * this isn't a codebase tour, it's a player's field guide.
 */
const PLAYER_INSTRUCTIONS = `You're commanding a live, persistent SpaceTraders fleet through these tools — not a simulation. Ships keep flying in the background between your calls, so re-checking state is cheap; re-issuing the same command usually isn't useful and can be actively confusing. A few things that read as "stuck" but usually aren't:

- **Fuel staying the same for a long time is normal, not a stall.** Fuel is spent all at once when a flight departs, not gradually during it. A ship mid-flight showing unchanged fuel for an hour+ is just... still flying. Only worry if its status/waypoint also hasn't changed across two checks spaced several minutes apart.
- **A quiet activity feed during a flight is also normal.** stcommand_get_activity logs discrete events — buy, sell, jump, refuel. A single long flight leg produces no new entries until it lands; that's not evidence anything went wrong.
- **Orbit/dock log lines near departure are often refueling, not arrival.** Don't read "docking → orbit" near a ship's departure time as "it arrived" — check the actual waypoint and IN_TRANSIT/IN_ORBIT/DOCKED status from stcommand_get_fleet_status, not activity-log phrasing alone.
- **A ship already IN_TRANSIT is already going where you sent it.** Calling dispatch_ship, hold_ship, or jump_ship again on it doesn't speed anything up or "kick it loose" — at best it's a no-op, at worst it just re-confirms the same instruction. If something really does look wrong, say so and describe the evidence rather than retrying blind.
- **dispatch_ship and jump_ship move a ship one leg/one gate at a time.** For a destination system more than one jump away, use dispatch_tour instead — it's built to walk a ship through however many hops it takes; a single jump_ship call to a far-away system will just fail.

When you genuinely think a ship is stuck: report what you actually see (status, waypoint, how long it's held, fuel trend) rather than guessing at a cause or re-issuing commands to "test" it — the operator can check server-side logs you can't see, and a clear symptom report gets a faster fix than a retried command.`;

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

    // Same visibility gap mcpAuth.ts's own comment describes — this is the
    // only trace of a request past auth until the response actually lands
    // or errors. req.body's jsonrpc "method" (initialize, tools/list,
    // tools/call, ...) is the single most useful field for telling a
    // client-side connection drop apart from a server-side one.
    const rpcMethod = (req.body as { method?: unknown } | undefined)?.method;
    console.log(`[mcp] tenant=${tenantId} method=${String(rpcMethod ?? "?")} — request received`);

    let worker;
    try {
      worker = await registry.getOrCreate(tenantId, agentSymbol);
    } catch (err) {
      console.error(`[mcp] tenant=${tenantId} engine boot failed`, err);
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `engine not ready: ${err instanceof Error ? err.message : String(err)}` },
        id: null,
      });
      return;
    }

    const server = new McpServer({ name: "stcommand", version: "1.0.0" }, { instructions: PLAYER_INSTRUCTIONS });
    registerTools(server, worker);

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      console.log(`[mcp] tenant=${tenantId} method=${String(rpcMethod ?? "?")} — response sent, status=${res.statusCode}`);
      res.on("close", () => {
        console.log(`[mcp] tenant=${tenantId} method=${String(rpcMethod ?? "?")} — connection closed`);
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error(`[mcp] tenant=${tenantId} method=${String(rpcMethod ?? "?")} — request error`, err);
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
