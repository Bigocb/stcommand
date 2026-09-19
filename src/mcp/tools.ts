import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import type { ShipType } from "../engine/fleet.js";

/**
 * Every tool registered here for a given request's `worker` (the caller's
 * own, already-resolved `TenantWorker` — see `server.ts`). Per
 * `docs/mcp-server-plan.md` §3, every write tool calls the *exact* same
 * `FleetManager`/`Store` method the matching `dashboard.ts` route calls —
 * these are thin adapters, not a second implementation of dashboard logic.
 * Naming, coverage, and phasing match that doc's §4/§7; the ones not yet
 * implemented here (bridge, markets, galaxy overview, missions/contracts/
 * warehouse/doctrine writes, the destructive-action confirm-flag tools)
 * are noted at the bottom of this file, not silently dropped.
 *
 * MANUAL_ROLES mirrors dashboard.ts's own local const exactly — neither
 * that one nor fleet.ts's private `ManualRole` type is exported, so this
 * is intentionally kept in sync by hand rather than duplicating an export
 * that doesn't otherwise need to exist.
 */
const MANUAL_ROLES = ["miner", "trader", "surveyor", "tour", "explorer", "keeper", "scout", "siphoner"] as const;

/** Every write tool's audit trail — reuses `operator_actions` (already
 *  designed for "the operator did X, distinct from the engine's own
 *  autonomous decisions") rather than inventing a parallel logging
 *  concept. `kind` is prefixed `mcp_` and `meta.source` is always
 *  `"mcp"`, resolving docs/mcp-server-plan.md §8's attribution decision:
 *  a later live-ops investigation can tell "an agent did this" from "the
 *  operator clicked this" by kind/meta alone, same table either way. */
async function recordMcpAction(
  w: TenantWorker,
  kind: string,
  shipSymbol: string | undefined,
  detail: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await w.store.recordOperatorAction(w.tenantId, `mcp_${kind}`, shipSymbol, detail, { source: "mcp", ...meta });
}

function textResult(structured: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured as Record<string, unknown> };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerTools(server: McpServer, w: TenantWorker): void {
  // ── Read-only ──────────────────────────────────────────────────────
  // All readOnlyHint/idempotentHint: true, per docs/mcp-server-plan.md §4.

  server.registerTool(
    "stcommand_get_state",
    {
      description: "Full current fleet/agent state snapshot — credits, ships, contracts, totals. Same data the dashboard's own live view reads.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(w.state.get()),
  );

  server.registerTool(
    "stcommand_get_fleet_status",
    {
      description: "Every ship's current role, live nav/cargo status, the fleet's committed intent per ship, whether the fleet is paused, and any stranded ships.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult({
      paused: w.fleet.isPaused(),
      running: w.fleet.running,
      ships: w.fleet.getShipStatuses(),
      summary: w.fleet.fleetStatusSummary(),
      stranded: w.fleet.getStrandedShips(),
    }),
  );

  server.registerTool(
    "stcommand_get_approvals",
    {
      description: "Every operator-approval request still awaiting a decision (ship purchases, autoExploreBorrow, etc.) — the same gate the dashboard's Approvals panel reads.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult({ approvals: await w.store.listOpenApprovals(w.tenantId) }),
  );

  server.registerTool(
    "stcommand_get_doctrine",
    {
      description: "This tenant's adopted doctrine rules plus the full catalog of every known policy (adopted or not).",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult({ rules: w.fleet.doctrine.list(), catalog: w.fleet.doctrine.catalog() }),
  );

  server.registerTool(
    "stcommand_get_activity",
    {
      title: "Recent fleet activity log",
      description: "The most recent entries in this tenant's activity feed (jumps, purchases, deliveries, etc.), newest first.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(100).describe("Max entries to return") },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) => textResult({ activity: await w.store.recentActivity(w.tenantId, limit) }),
  );

  server.registerTool(
    "stcommand_get_ship_state",
    {
      description: "The persisted per-ship lifecycle table as of the last coordinator tick (what survives a restart) — distinct from stcommand_get_fleet_status, which reads live in-memory state.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult({ states: await w.store.getAllShipStates(w.tenantId) }),
  );

  // ── Fleet actions (write) ────────────────────────────────────────────
  // Each calls the exact FleetManager method the matching dashboard.ts
  // route calls — see this file's header comment.

  server.registerTool(
    "stcommand_dispatch_ship",
    {
      title: "Dispatch (hold) a ship at a waypoint",
      description: "Send a ship to a specific waypoint and hold it there once it arrives, cancelling any standing automatic tour destination — the ship stays put until released or dispatched/jumped again. Equivalent to the dashboard's manual dispatch control.",
      inputSchema: {
        shipSymbol: z.string().describe("e.g. THEO-1C"),
        waypointSymbol: z.string().describe("Full waypoint symbol, e.g. X1-TX45-A1"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ shipSymbol, waypointSymbol }) => {
      try {
        await w.fleet.sendShipTo(shipSymbol, waypointSymbol);
        await recordMcpAction(w, "dispatch", shipSymbol, `${shipSymbol} -> ${waypointSymbol}`, { waypointSymbol });
        return textResult({ ok: true, shipSymbol, waypointSymbol, held: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_hold_ship",
    {
      description: "Hold a ship exactly where it currently is — same effect as stcommand_dispatch_ship at the ship's own present waypoint.",
      inputSchema: { shipSymbol: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ shipSymbol }) => {
      try {
        await w.fleet.holdShip(shipSymbol);
        await recordMcpAction(w, "hold", shipSymbol, `held ${shipSymbol}`);
        return textResult({ ok: true, shipSymbol, held: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_release_ship",
    {
      description: "Release a ship from an operator hold, letting the fleet's automatic controllers resume assigning it work.",
      inputSchema: { shipSymbol: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ shipSymbol }) => {
      try {
        await w.fleet.releaseShip(shipSymbol);
        await recordMcpAction(w, "release", shipSymbol, `released ${shipSymbol}`);
        return textResult({ ok: true, shipSymbol, held: false });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_jump_ship",
    {
      title: "Jump a ship to a specific waypoint in another system",
      description: "Jump a ship through a gate to a specific destination waypoint and hold it there, clearing any stale automatic tour destination. Equivalent to the dashboard's Navigate-tab jump control.",
      inputSchema: {
        shipSymbol: z.string(),
        waypointSymbol: z.string().describe("Destination waypoint in another system, e.g. X1-TX45-I55"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ shipSymbol, waypointSymbol }) => {
      try {
        await w.fleet.manualJumpShip(shipSymbol, waypointSymbol);
        await recordMcpAction(w, "jump", shipSymbol, `${shipSymbol} jumped to ${waypointSymbol}`, { waypointSymbol });
        return textResult({ ok: true, shipSymbol, waypointSymbol, held: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_dispatch_tour",
    {
      title: "Send a tour ship on a multi-hop trip to a system",
      description: "Assign a ship the tour role (if not already) and start it walking the known jump-gate graph toward a target system, one hop per tick — once it arrives, it tours that system's markets indefinitely on its own. Not a hold: the ship remains eligible for its normal tour duties, and (as of this session's own fix) is excluded from autoExplore's borrow pool only while the trip is still in progress.",
      inputSchema: {
        shipSymbol: z.string(),
        targetSystem: z.string().describe("System symbol, e.g. X1-TX45 (not a waypoint)"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ shipSymbol, targetSystem }) => {
      try {
        await w.fleet.dispatchTourShip(shipSymbol, targetSystem);
        await recordMcpAction(w, "tour_dispatch", shipSymbol, `${shipSymbol} dispatched to tour ${targetSystem}`, { targetSystem });
        return textResult({ ok: true, shipSymbol, targetSystem });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_set_ship_role",
    {
      description: "Reassign a ship's role (miner, trader, surveyor, tour, explorer, keeper, scout, siphoner). Interrupts whatever the ship was doing under its previous role.",
      inputSchema: {
        shipSymbol: z.string(),
        role: z.enum(MANUAL_ROLES),
        keeperMarket: z.string().optional().describe("Required only when role is \"keeper\": the market waypoint this ship should camp"),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ shipSymbol, role, keeperMarket }) => {
      try {
        await w.fleet.setShipRole(shipSymbol, role, keeperMarket);
        await recordMcpAction(w, "role_change", shipSymbol, `${shipSymbol} -> ${role}`, { role, keeperMarket });
        return textResult({ ok: true, shipSymbol, role });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_dock_toggle",
    {
      description: "Toggle a ship between docked and orbiting at its current waypoint. Fails if the ship is in transit.",
      inputSchema: { shipSymbol: z.string() },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ shipSymbol }) => {
      try {
        const api = w.fleet.getApi();
        const ship = await api.getShip(shipSymbol);
        if (ship.nav.status === "IN_TRANSIT") return errorResult(new Error(`${shipSymbol} is in transit — wait for arrival`));
        if (ship.nav.status === "DOCKED") await api.orbitShip(shipSymbol);
        else await api.dockShip(shipSymbol);
        const updated = await api.getShip(shipSymbol);
        return textResult({ ok: true, shipSymbol, status: updated.nav.status });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_refuel_ship",
    {
      description: "Refuel a ship at its current market. Spends credits.",
      inputSchema: { shipSymbol: z.string() },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ shipSymbol }) => {
      try {
        const r = await w.fleet.refuelShip(shipSymbol);
        await recordMcpAction(w, "refuel", shipSymbol, `refueled ${shipSymbol} for ${r.cost}c`, r);
        return textResult({ ok: true, shipSymbol, ...r });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_buy_ship",
    {
      description: "Buy a new ship of the given type at a shipyard waypoint the fleet already knows stocks it. Spends real credits — check stcommand_get_state's credits first.",
      inputSchema: {
        shipType: z.string().describe("e.g. SHIP_PROBE, SHIP_LIGHT_HAULER"),
        yardSymbol: z.string().describe("Shipyard waypoint symbol"),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ shipType, yardSymbol }) => {
      try {
        const ship = await w.fleet.buyShip(shipType as ShipType, yardSymbol);
        await recordMcpAction(w, "buy", ship.symbol, `bought ${shipType} at ${yardSymbol}`, { shipType, yardSymbol });
        return textResult({ ok: true, shipSymbol: ship.symbol, shipType, yardSymbol });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Approvals (write) ────────────────────────────────────────────────

  server.registerTool(
    "stcommand_decide_approval",
    {
      description: "Approve or deny a pending operator-approval request (from stcommand_get_approvals). This is the same ApprovalGate every autonomous fleet decision (ship purchases, autoExploreBorrow) already waits on — deciding here is exactly what clicking Approve/Deny on the dashboard does.",
      inputSchema: {
        id: z.string().describe("Approval id, from stcommand_get_approvals"),
        decision: z.enum(["approved", "denied"]),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, decision }) => {
      try {
        await w.store.decideApproval(w.tenantId, id, decision);
        await recordMcpAction(w, "decide_approval", undefined, `approval ${id} ${decision}`, { id, decision });
        return textResult({ ok: true, id, decision });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/**
 * Not yet implemented (tracked in docs/mcp-server-plan.md §4/§7, not
 * silently dropped): stcommand_get_bridge and stcommand_get_markets (both
 * compose several store calls the way dashboard.ts's own handlers do —
 * worth factoring that composition out of dashboard.ts into a shared
 * function both callers use, rather than duplicating it here, when this
 * server's next round of tools gets built) and stcommand_get_galaxy_overview
 * (same reasoning); the missions/contracts/warehouse/doctrine write tools
 * from the plan's §4 tables; and the confirm-flag requirement on
 * stcommand_scrap_ship/stcommand_sell_ship/stcommand_abandon_contract/
 * stcommand_pause_fleet once those are added (§5 of the plan).
 */
