import * as z from "zod";
import { registerOpsTools } from "../ops/mcp.js";
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
  registerOpsTools(server, w); // read-only investigation suite — src/ops/, docs/ops-layer-design.md
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

  // ── Trading / pricing intel (read-only) ──────────────────────────────
  // Same underlying data the dashboard's Markets tab (/api/markets,
  // /api/prices, /api/goods) reads — no separate query logic invented here,
  // per this file's header comment.

  server.registerTool(
    "stcommand_get_goods",
    {
      description: "Every trade good symbol this tenant has ever observed a price for — use this to resolve a plain-language good name to its exact TradeSymbol before calling the other pricing tools.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const snaps = await w.store.latestMarketSnapshots();
      return textResult({ goods: [...new Set(snaps.map((s) => s.goodSymbol))].sort() });
    },
  );

  server.registerTool(
    "stcommand_get_best_price",
    {
      title: "Best known buy/sell price for a good",
      description: "Where to buy a good cheapest and sell it highest, across every market this tenant has actually charted — same freshness window and charted-systems scoping the dashboard's Markets tab uses (a tenant never sees another tenant's unexplored markets, even though market data itself is shared across the whole server).",
      inputSchema: {
        good: z.string().describe("Exact TradeSymbol, e.g. FAB_MATS — use stcommand_get_goods if unsure of the exact symbol"),
        system: z.string().optional().describe("Restrict to one system symbol, e.g. X1-TX45"),
        maxResultsEach: z.number().int().min(1).max(20).default(5).describe("How many cheapest-buy and best-sell locations to return"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ good, system, maxResultsEach }) => {
      const maxAgeMin = w.fleet.doctrine.value("snapshotMaxAgeMin", 5_256_000);
      const charted = new Set(w.fleet.getChartedSystems());
      let rows = (await w.store.freshMarketSnapshots(maxAgeMin))
        .filter((s) => charted.has(s.systemSymbol) && s.goodSymbol === good);
      if (system) rows = rows.filter((s) => s.systemSymbol === system);
      if (rows.length === 0) {
        return textResult({ good, system: system ?? null, cheapestToBuy: [], bestToSell: [], note: "no fresh, charted price data for this good — try a broader system scope, or send a ship to observe it" });
      }
      const cheapestToBuy = [...rows].sort((a, b) => a.purchasePrice - b.purchasePrice).slice(0, maxResultsEach)
        .map((r) => ({ waypointSymbol: r.waypointSymbol, systemSymbol: r.systemSymbol, purchasePrice: r.purchasePrice, supply: r.supply, tradeVolume: r.tradeVolume, observedAt: r.timestamp }));
      const bestToSell = [...rows].sort((a, b) => b.sellPrice - a.sellPrice).slice(0, maxResultsEach)
        .map((r) => ({ waypointSymbol: r.waypointSymbol, systemSymbol: r.systemSymbol, sellPrice: r.sellPrice, supply: r.supply, tradeVolume: r.tradeVolume, observedAt: r.timestamp }));
      return textResult({ good, system: system ?? null, cheapestToBuy, bestToSell });
    },
  );

  server.registerTool(
    "stcommand_get_price_trend",
    {
      title: "Price trend for a good over time",
      description: "Per-minute average/min/max sell price across every market observation of this good since the given time — shows whether a price is rising, falling, or stable.",
      inputSchema: {
        good: z.string().describe("Exact TradeSymbol, e.g. FAB_MATS"),
        sinceHours: z.number().min(0.5).max(24 * 30).default(24).describe("How far back to look, in hours"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ good, sinceHours }) => {
      const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
      const points = await w.store.goodPriceHistory(good, since);
      return textResult({ good, sinceHours, points });
    },
  );

  server.registerTool(
    "stcommand_get_shipyard_inventory",
    {
      title: "Shipyard inventory across charted systems",
      description: "Every ship type this tenant has observed for sale at every shipyard it's charted, with price and hull stats — optionally filtered to one system or ship type.",
      inputSchema: {
        system: z.string().optional().describe("Restrict to one system symbol, e.g. X1-TX45"),
        shipType: z.string().optional().describe("Restrict to one ship type, e.g. SHIP_LIGHT_HAULER"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ system, shipType }) => {
      const { shipyards } = await w.fleet.getIntel();
      const filtered = shipyards.filter((y) => (!system || y.systemSymbol === system) && (!shipType || y.shipType === shipType));
      return textResult({ shipyards: filtered });
    },
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
    "stcommand_trade_cargo",
    {
      description: "Buy or sell cargo for a ship at the market it is currently at (docks it if needed). One call = one game transaction, capped by the market's tradeVolume. Returns the transaction price and the market listing before/after, so price impact can be measured. Buying spends real credits and is subject to the cash floor. Interrupts nothing, but a ship that is part of a feed/route may keep acting on its own — hold it first (stcommand_hold_ship) when running experiments.",
      inputSchema: {
        shipSymbol: z.string(),
        good: z.string().describe("Exact TradeSymbol, e.g. QUARTZ_SAND"),
        units: z.number().int().positive(),
        action: z.enum(["buy", "sell"]),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ shipSymbol, good, units, action }) => {
      try {
        const result = action === "buy"
          ? await w.fleet.buyCargo(shipSymbol, good, units, true)
          : await w.fleet.sellCargo(shipSymbol, good, units, true);
        await recordMcpAction(w, "trade_cargo", shipSymbol, `${action} ${result.units}u ${good} @ ${result.pricePerUnit}c`);
        return textResult({ ok: true, shipSymbol, good, action, ...result });
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
    "stcommand_assign_route",
    {
      title: "Manually assign a trader to a specific buy→sell route",
      description: "Pin a trader to one direct route (buy a good at buyAt, sell it at sellAt — either may be in another system). Same as the dashboard's \"Assign route\": it overrides the dispatcher for this ship, reserves the good so no other trader is auto-sent on it, and sticks until cleared with stcommand_clear_route. Use it when the automatic dispatcher's crowding penalty is under-rating a route you want run. Prices are optional hints for display; the trader reads live prices when it buys.",
      inputSchema: {
        shipSymbol: z.string(),
        good: z.string().describe("Exact TradeSymbol, e.g. ADVANCED_CIRCUITRY"),
        buyAt: z.string().describe("Waypoint to buy at"),
        sellAt: z.string().describe("Waypoint to sell at"),
        buyPrice: z.number().optional(),
        sellPrice: z.number().optional(),
        profitPerTrip: z.number().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ shipSymbol, good, buyAt, sellAt, buyPrice, sellPrice, profitPerTrip }) => {
      try {
        await w.fleet.setManualDispatch(shipSymbol, {
          shipSymbol, good, role: "direct", buyAt, sellAt,
          buyPrice: buyPrice ?? 0, sellPrice: sellPrice ?? 0, profitPerTrip: profitPerTrip ?? 0,
          source: "manual",
        });
        await recordMcpAction(w, "route_assign", shipSymbol, `${shipSymbol}: ${good} ${buyAt} -> ${sellAt}`, { good, buyAt, sellAt });
        return textResult({ ok: true, shipSymbol, good, buyAt, sellAt });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_clear_route",
    {
      title: "Clear a trader's manual route",
      description: "Remove a manual route set with stcommand_assign_route (or the dashboard), returning the ship to the automatic dispatcher.",
      inputSchema: { shipSymbol: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ shipSymbol }) => {
      try {
        await w.fleet.setManualDispatch(shipSymbol, undefined);
        await recordMcpAction(w, "route_clear", shipSymbol, `${shipSymbol}: manual route cleared`);
        return textResult({ ok: true, shipSymbol, cleared: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_set_miner_preference",
    {
      title: "Set (or clear) which good a miner's or surveyor's surveys favor",
      description: "Bias a miner or surveyor toward a good (e.g. IRON_ORE, COPPER_ORE): the survey predicate prefers deposits that yield it. Same as the dashboard's miner preference. It biases, it never guarantees — the field must actually have that deposit. Omit `good` (or pass clear=true) to remove the preference. With no shipSymbol, just lists current preferences.",
      inputSchema: {
        shipSymbol: z.string().optional(),
        good: z.string().optional().describe("Exact TradeSymbol, e.g. IRON_ORE"),
        clear: z.boolean().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ shipSymbol, good, clear }) => {
      try {
        if (!shipSymbol) return textResult({ minerPreferences: w.fleet.minerPreferenceList() });
        if (clear || !good) {
          await w.fleet.setMinerPreference(shipSymbol, undefined);
          await recordMcpAction(w, "miner_preference", shipSymbol, `${shipSymbol}: preference cleared`, { good: null });
        } else {
          await w.fleet.setMinerPreference(shipSymbol, good.trim().toUpperCase());
          await recordMcpAction(w, "miner_preference", shipSymbol, `${shipSymbol}: preference -> ${good.trim().toUpperCase()}`, { good: good.trim().toUpperCase() });
        }
        return textResult({ ok: true, minerPreferences: w.fleet.minerPreferenceList() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_get_missions",
    {
      title: "List construction missions",
      description: "Every construction-supply mission (e.g. the jump gate): status, paused flag, crew, each material's required/fulfilled, and its buy pacing (lot size, minimum gap, price ceiling; null = defaults).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return textResult({ missions: await w.fleet.getMissions() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_sell_ship",
    {
      title: "Sell (scrap) a ship",
      description: "Retire a hull for credits: the ship stops its work, flies to the nearest known shipyard (same system or one gate hop) and is scrapped there; a ship already docked at a yard is scrapped at once. Irreversible, and scrap pays only part of the purchase price. Requires confirm=true.",
      inputSchema: { shipSymbol: z.string(), confirm: z.boolean().describe("Must be true; this cannot be undone") },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ shipSymbol, confirm }) => {
      if (!confirm) return errorResult(new Error("confirm must be true to sell a ship"));
      try {
        const yard = await w.fleet.sellShip(shipSymbol);
        await recordMcpAction(w, "ship_sell", shipSymbol, `${shipSymbol}: sold, scrapping at ${yard}`, { yard });
        return textResult({ ok: true, shipSymbol, yard });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_get_chain_health",
    {
      title: "Gate supply chain health",
      description: "For every material an unfinished construction mission still needs: each in-system producer market (ask, supply, activity = production strength, trade volume, 24h low and the mission's price ceiling) and under it every input that producer imports (supply, activity = consumption strength, cheapest in-system source, the feed serving it, and which input is the weakest link). Inputs that are themselves produced in-system nest one level further. An export is RESTRICTED while any input is SCARCE; aim to hold every input at HIGH with both import activities STRONG.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return textResult(await w.fleet.chainHealth());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_set_mission_pacing",
    {
      title: "Set a mission's buy pacing",
      description: "Slow a construction mission's buying so it does not outrun the market's refill. Price depends on total units bought, not how they are split, so what matters is the RATE: buyLotUnits caps units per purchase, buyGapMin is the minimum minutes between purchases of a material, maxInflationPct is the price ceiling in percent above the market's trailing-24h low (default 40), recoverPct buys the next lot only once the ask is back within that percent of what it was before the previous lot (a sawtooth that follows the market's refill; 3-5 is a sensible start). A number sets a key, null clears it to the default, omitting it leaves it unchanged.",
      inputSchema: {
        waypoint: z.string().describe("The construction site, e.g. X1-JX83-I59"),
        buyLotUnits: z.number().int().nullable().optional(),
        buyGapMin: z.number().int().nullable().optional(),
        maxInflationPct: z.number().int().nullable().optional(),
        recoverPct: z.number().int().nullable().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint, buyLotUnits, buyGapMin, maxInflationPct, recoverPct }) => {
      try {
        const pacing = await w.fleet.setMissionPacing(waypoint, { buyLotUnits, buyGapMin, maxInflationPct, recoverPct });
        await recordMcpAction(w, "mission_pacing", waypoint, `pacing ${pacing ? JSON.stringify(pacing) : "cleared"}`);
        return textResult({ ok: true, waypoint, pacing });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_pause_mission",
    {
      title: "Pause a construction mission",
      description: "Stop a mission sourcing and spending, and release its crew back to autonomy.",
      inputSchema: { waypoint: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint }) => {
      try {
        await w.fleet.pauseMission(waypoint);
        await recordMcpAction(w, "mission_pause", waypoint, `paused mission ${waypoint}`);
        return textResult({ ok: true, waypoint, paused: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_resume_mission",
    {
      title: "Resume a construction mission",
      description: "Resume a paused mission; it re-staffs toward its crew target and starts buying again, subject to its pacing.",
      inputSchema: { waypoint: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint }) => {
      try {
        await w.fleet.resumeMission(waypoint);
        await recordMcpAction(w, "mission_resume", waypoint, `resumed mission ${waypoint}`);
        return textResult({ ok: true, waypoint, paused: false });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_get_feeds",
    {
      title: "List feeder tiers",
      description: "Every active feed: a crew that sources a good (by mining or buying) and sells it into a target market. Shows the target waypoint, good, whether it mines, crew size wanted, and the ships assigned.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return textResult({ feeds: await w.fleet.getFeeds() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_start_feed",
    {
      title: "Start a feeder tier",
      description: "Start a feed: a crew that sources `good` and sells it into `waypoint` (e.g. IRON_ORE into the refinery market H55). mine=true sources by mining (miners are claimed by the feed, so contracts/missions cannot take them, and their survey preference is wired to the good); mine=false buys it. carrierTarget is how many ships to staff. Same as the dashboard's Feeder tiers form.",
      inputSchema: {
        waypoint: z.string().describe("Market that receives the good"),
        good: z.string().describe("Exact TradeSymbol, e.g. IRON_ORE"),
        mine: z.boolean().optional().describe("Source by mining instead of buying"),
        carrierTarget: z.number().int().positive().optional().describe("Crew size to staff (default 1)"),
        buyAt: z.string().optional(),
        sellGapMin: z.number().positive().optional().describe("Minutes between sells (optional pacing)"),
        force: z.boolean().optional().describe("Override the margin gate"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint, good, mine, carrierTarget, buyAt, sellGapMin, force }) => {
      try {
        await w.fleet.startFeed(waypoint, good.toUpperCase(), carrierTarget ?? 1, mine === true, buyAt, force === true, sellGapMin ? sellGapMin * 60_000 : undefined);
        await recordMcpAction(w, "feed_start", undefined, `feed ${good.toUpperCase()} -> ${waypoint}${mine ? " (mine)" : ""} x${carrierTarget ?? 1}`, { waypoint, good, mine: mine === true, carrierTarget: carrierTarget ?? 1 });
        return textResult({ ok: true, feeds: await w.fleet.getFeeds() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_set_feed_limits",
    {
      title: "Set a feed's loss tolerance and stop rule",
      description: "Make a feed deliberately subsidised and self-limiting. maxLossPerUnit: credits per unit the feed will pay ABOVE what the target market pays (replaces the default 10% margin gate; use to keep a producer's input healthy at a small loss). stopAtSupply: MODERATE, HIGH or ABUNDANT — stop sourcing once the target's supply for the good reaches that bucket (aim for HIGH: over-feeding an import makes its market's trade volume and consumption grow, after which it needs far more to stay supplied). A number/string sets, null clears, omitted leaves unchanged.",
      inputSchema: {
        waypoint: z.string().describe("The feed's target market"),
        good: z.string(),
        maxLossPerUnit: z.number().int().min(0).nullable().optional(),
        stopAtSupply: z.enum(["MODERATE", "HIGH", "ABUNDANT"]).nullable().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint, good, maxLossPerUnit, stopAtSupply }) => {
      try {
        await w.fleet.setFeedLimits(waypoint, good.toUpperCase(), { maxLossPerUnit, stopAtSupply });
        await recordMcpAction(w, "feed_limits", undefined, `feed ${good.toUpperCase()} -> ${waypoint}: max loss ${maxLossPerUnit ?? "unchanged"}, stop at ${stopAtSupply ?? "unchanged"}`, { waypoint, good, maxLossPerUnit, stopAtSupply });
        return textResult({ ok: true, feeds: await w.fleet.getFeeds() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_set_feed_collector",
    {
      title: "Drone-plus-collector mining on a mine feed",
      description: "Pin a mine feed's drones to one asteroid (`field`) and name a shuttle (`collector`, a trader hull with a 40+ hold) that waits in orbit there, takes each drone's hold through the cargo-transfer endpoint and flies the full load to the feed's target market. The drones never leave the field, so a far asteroid (beyond a drone's tank) becomes workable and the 15-unit round trips go away. Also obeys the feed's stop rule. null clears either value; omitted leaves it unchanged. Use 2-4 drones per asteroid: ~8 extractions per 70 s makes one unstable.",
      inputSchema: {
        waypoint: z.string().describe("The feed's target market"),
        good: z.string(),
        field: z.string().nullable().optional().describe("Asteroid waypoint for the drones"),
        collector: z.string().nullable().optional().describe("Shuttle symbol, not on any other feed"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint, good, field, collector }) => {
      try {
        await w.fleet.setFeedCollector(waypoint, good.toUpperCase(), { field: field === undefined ? undefined : field, collector: collector === undefined ? undefined : collector });
        await recordMcpAction(w, "feed_collector", collector ?? undefined, `feed ${good.toUpperCase()} -> ${waypoint}: field ${field ?? "unchanged"}, collector ${collector ?? "unchanged"}`, { waypoint, good, field, collector });
        return textResult({ ok: true, feeds: await w.fleet.getFeeds() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_assign_feed_carrier",
    {
      title: "Add a specific ship to a feed's crew",
      description: "Pin one ship (a miner for a mine feed, a trader otherwise) to an existing feed. It must not already be on another feed or mission.",
      inputSchema: { waypoint: z.string(), good: z.string(), shipSymbol: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ waypoint, good, shipSymbol }) => {
      try {
        await w.fleet.assignFeedCarrier(waypoint, good.toUpperCase(), shipSymbol);
        await recordMcpAction(w, "feed_assign", shipSymbol, `${shipSymbol} -> feed ${good.toUpperCase()} @ ${waypoint}`, { waypoint, good });
        return textResult({ ok: true, feeds: await w.fleet.getFeeds() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_remove_feed",
    {
      title: "Stop and forget a feed",
      description: "Remove a feed entirely (releases its crew back to automatic control).",
      inputSchema: { waypoint: z.string(), good: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ waypoint, good }) => {
      try {
        await w.fleet.removeFeed(waypoint, good.toUpperCase());
        await recordMcpAction(w, "feed_remove", undefined, `feed ${good.toUpperCase()} @ ${waypoint} removed`, { waypoint, good });
        return textResult({ ok: true, feeds: await w.fleet.getFeeds() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_mine_at",
    {
      title: "Pin a miner or surveyor to one asteroid field (or release the pin)",
      description: "Pin a mining/survey ship to a specific asteroid field. Unlike stcommand_dispatch_ship the ship keeps working — it keeps mining, hauling and selling on its own, it just stops choosing the field. Needed because the engine's field-spread default sends new miners to whichever field has the fewest ships, which can be hundreds of units from the market they sell into. Pass release=true to hand field choice back.",
      inputSchema: { shipSymbol: z.string(), field: z.string().optional().describe("Asteroid waypoint, e.g. X1-JX83-CE5D"), release: z.boolean().optional() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ shipSymbol, field, release }) => {
      try {
        if (release) {
          await w.fleet.unpinMining(shipSymbol);
          await recordMcpAction(w, "mine_release", shipSymbol, `${shipSymbol}: field pin released`);
          return textResult({ ok: true, shipSymbol, released: true });
        }
        if (!field) throw new Error("field is required unless release=true");
        await w.fleet.mineAt(shipSymbol, field);
        await recordMcpAction(w, "mine_at", shipSymbol, `${shipSymbol}: pinned to mine at ${field}`, { field });
        return textResult({ ok: true, shipSymbol, field });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stcommand_set_doctrine",
    {
      title: "Change a standing-order (doctrine) rule",
      description: "Set a doctrine rule's value and/or enabled flag by key (see stcommand_get_doctrine for keys), e.g. autoKeeperProbes enabled=false to stop automatic keeper-probe purchases, or fieldSpreadEnabled enabled=false. Same as the dashboard's Doctrine edit. Takes effect on the next tick.",
      inputSchema: { key: z.string(), value: z.number().optional(), enabled: z.boolean().optional() },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ key, value, enabled }) => {
      try {
        const rule = await w.fleet.doctrine.set(key, { value, enabled });
        await recordMcpAction(w, "doctrine", undefined, `doctrine ${key}: ${value !== undefined ? `value=${value} ` : ""}${enabled !== undefined ? `enabled=${enabled}` : ""}`.trim(), { key, value, enabled });
        return textResult({ ok: true, rule });
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
 * silently dropped): stcommand_get_bridge and stcommand_get_markets's own
 * *routes* view (best-profit round trips accounting for fuel/distance,
 * not just raw price — the trading-tools group above answers "best price"
 * and "trend", not "best round-trip route") and stcommand_get_galaxy_overview
 * (all three compose several store calls the way dashboard.ts's own
 * handlers do — worth factoring that composition out of dashboard.ts into
 * a shared function both callers use, rather than duplicating it here);
 * the missions/contracts/warehouse/doctrine write tools from the plan's §4
 * tables; and the confirm-flag requirement on
 * stcommand_scrap_ship/stcommand_sell_ship/stcommand_abandon_contract/
 * stcommand_pause_fleet once those are added (§5 of the plan).
 */
