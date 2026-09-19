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
 * behaves" — a player's field guide, not a codebase tour. Broadened
 * 2026-09-19 from just the "looks stuck but isn't" section (still below,
 * unchanged in substance) into a general orientation — roles, gates,
 * trading, ships — at the operator's request, so a newly-connected agent
 * doesn't have to rediscover fleet basics the hard way, the way several
 * connected agents already have this session.
 */
const PLAYER_INSTRUCTIONS = `You're commanding a live, persistent SpaceTraders fleet through these tools — not a simulation, and not turn-based. Ships keep flying in the background between your calls, so re-checking state is cheap; re-issuing a command usually isn't useful (see "things that look broken" below). Every tool call acts immediately on the real fleet at operator trust level — there's no separate confirm step except stcommand_decide_approval's own gate (see Approvals).

## Ship roles

Every ship has exactly one role at a time, set by stcommand_set_ship_role — reassigning one interrupts whatever it was doing, so don't do it to a ship mid-task without reason.

- **trader** — runs its own buy-low/sell-high round trips automatically once assigned; the fleet's own dispatcher picks its route from current best margins. You generally don't need to buy/sell by hand for these.
- **miner** / **siphoner** — extracts raw resources (ore, gas) at an asteroid field or gas giant and feeds it to traders or the warehouse.
- **surveyor** — scouts extraction sites to make nearby miners more efficient; doesn't haul cargo itself.
- **explorer** — jumps around charting unexplored systems and waypoints. The source of "new galaxy" data everything else (traders, tour ships) depends on.
- **scout** — charts nearby uncharted waypoints without jumping; shorter-range than explorer.
- **tour** — visits every market/shipyard in a system to keep price and shipyard-inventory intel fresh. Send one to a whole new system with stcommand_dispatch_tour.
- **keeper** — permanently camps one specific market/shipyard (its keeperMarket) so it's always fresh, rather than touring past it occasionally.

## Moving ships

- **stcommand_dispatch_ship** — send a ship to a waypoint in its *current* system and hold it there once it arrives.
- **stcommand_jump_ship** — jump through a gate to a waypoint in an *adjacent* system (one hop only) and hold there.
- **stcommand_dispatch_tour** — for a system *more than one jump away*: give it a system symbol (not a waypoint) and it walks the known jump-gate graph automatically, one hop per tick, however many jumps it takes. Use this, not jump_ship, for anything beyond one hop — a direct jump_ship call to a far system just fails.
- **stcommand_hold_ship** / **stcommand_release_ship** — freeze a ship exactly where it is / hand it back to the fleet's own automatic controllers. A ship under any manual hold (dispatch/jump/hold) stays put until released or given a new instruction.

Fuel is charged in full the instant a flight departs, not drained gradually over the trip — an unchanged fuel number mid-flight is normal, not a problem. The game itself falls back between cruise (normal), drift (slow, minimal fuel — used automatically when the tank can't cover cruise), and burn (fast, more fuel); a drift leg across real distance can take hours. stcommand_refuel_ship tops off at the ship's current market and spends credits.

## Trading and prices

- **stcommand_get_goods** — every trade-good symbol this fleet has ever priced; use it to resolve a plain name to its exact TradeSymbol before calling the other pricing tools.
- **stcommand_get_best_price** — cheapest place to buy and highest to sell a given good, across every market this fleet has charted.
- **stcommand_get_price_trend** — whether a good's price is rising, falling, or flat over a given window.

These answer "what should we be trading" or "why did this route stop paying" — trader ships run their own routes automatically once assigned, so you're rarely buying/selling by hand.

## Ships and shipyards

- **stcommand_get_shipyard_inventory** — every ship type and price this fleet has observed for sale, at every charted shipyard.
- **stcommand_buy_ship** — purchase one at a shipyard waypoint the fleet already knows stocks it. Spends real credits — check stcommand_get_state's credits field first.

## Approvals

Some fleet decisions (an idle ship about to be borrowed for exploring, certain purchases) pause for a yes/no instead of happening automatically. stcommand_get_approvals lists anything waiting; stcommand_decide_approval approves or denies it. Nothing else requires sign-off.

## Checking fleet state

- **stcommand_get_fleet_status** — every ship's role, live position/nav status, cargo, and whether the fleet is paused. The first thing to check for "what's going on right now."
- **stcommand_get_ship_state** — the persisted version of the same, as of the last processing tick (what survives a restart).
- **stcommand_get_activity** — recent buy/sell/jump/refuel events, newest first.
- **stcommand_get_state** — the full agent snapshot: credits, ships, contracts, totals.

## Things that look broken but usually aren't

- **Fuel staying the same for a long time is normal, not a stall.** Fuel is spent all at once when a flight departs, not gradually during it. A ship mid-flight showing unchanged fuel for an hour+ is just... still flying. Only worry if its status/waypoint also hasn't changed across two checks spaced several minutes apart.
- **A quiet activity feed during a flight is also normal.** stcommand_get_activity logs discrete events — buy, sell, jump, refuel. A single long flight leg produces no new entries until it lands; that's not evidence anything went wrong.
- **Orbit/dock log lines near departure are often refueling, not arrival.** Don't read "docking → orbit" near a ship's departure time as "it arrived" — check the actual waypoint and IN_TRANSIT/IN_ORBIT/DOCKED status from stcommand_get_fleet_status, not activity-log phrasing alone.
- **A ship already IN_TRANSIT is already going where you sent it.** Calling dispatch_ship, hold_ship, or jump_ship again on it doesn't speed anything up or "kick it loose" — at best it's a no-op, at worst it just re-confirms the same instruction. If something really does look wrong, say so and describe the evidence rather than retrying blind.

When you genuinely think a ship is stuck: report what you actually see (status, waypoint, how long it's held, fuel trend) rather than guessing at a cause or re-issuing commands to "test" it — the operator can check server-side logs you can't see, and a clear symptom report gets a faster fix than a retried command.

## What this server doesn't cover

This is scoped to one tenant's fleet (yours) — no cross-tenant access, no admin/infrastructure actions. If something needs the operator's own dashboard or server access, say so rather than trying to work around it with these tools.`;

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
