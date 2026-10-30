import * as z from "zod";
import { gateAtOrBefore, gateBuildTime } from "../engine/agentWatch.js";
import { systemCandidates } from "./systems.js";
import { explorerReport } from "./explorers.js";
import { buildKeeperReview } from "../engine/keeperValue.js";
import { keeperSales } from "../engine/keeperSales.js";
import { rivalActivity } from "../engine/rivalActivity.js";
import { chartRewardReport } from "../engine/chartReward.js";
import { DEFAULT_CANDIDATE_POLICY } from "../engine/systems/candidates.js";
import { logBuffer } from "../core/logBuffer.js";
import { INSTANCE_ID, rateLimitMonitor } from "../core/rateLimitMonitor.js";
import { classifyShips, hopsWithin, keeperReport, type StateShip, type SummaryShip } from "./classify.js";
import { resetWatcherStatus } from "../engine/resetWatcher.js";
import { universeKey } from "../engine/universe.js";
import { deadheadFromTrades } from "../engine/deadhead.js";
import { selectExplain } from "../engine/dispatchExplain.js";
import { heapReport, heapStart, heapStop, profileCpu, runtimeStatus } from "./profiler.js";
import type { OpsTool } from "./types.js";
import { buildMetrics, bucketMinutesFor } from "../engine/metrics.js";
import { miningFieldsReport, type FieldWaypoint } from "../engine/miningFields.js";
import { contractsOverview } from "../http/contractsOverview.js";
import { runAnalysis } from "./analysis.js";
import { DEFAULT_YARD_POLICY, yardReport } from "../engine/yardScan.js";
import { summarizeDirectory } from "../engine/marketDirectory.js";

/** Query-string friendly booleans ("true"/"false") as well as real ones. */
const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional();
const num = (def: number) => z.coerce.number().optional().default(def);

const iso = (ms: number) => new Date(ms).toISOString();

function stateShips(ctx: { w: { state: { get: () => unknown } } }): StateShip[] {
  return ((ctx.w.state.get() as { ships?: StateShip[] }).ships ?? []) as StateShip[];
}

export const OPS_TOOLS: OpsTool[] = [
  {
    name: "logs",
    title: "Recent server log lines",
    description:
      "Recent log lines from this server process's in-memory buffer (resets on restart), newest last. Filter by free text and/or ship (whole-token match: THEO-1 does not match THEO-1A). The ~100-ship `fleet:` roll-up and per-keeper snapshot lines are hidden unless noise=true — they are what makes a plain provider-side log search unusable.",
    input: {
      text: z.string().optional(),
      ship: z.string().optional(),
      sinceMin: num(60),
      limit: num(60),
      noise: bool,
    },
    async run(ctx, a) {
      const lines = logBuffer.query({ tenantId: ctx.w.tenantId, text: a.text, ship: a.ship, sinceMs: ctx.now() - a.sinceMin * 60_000, limit: Math.min(a.limit, 300), noise: a.noise });
      return { asOf: iso(ctx.now()), buffered: logBuffer.size(), returned: lines.length, lines: lines.map((l) => `${iso(l.at).slice(11, 19)} ${l.msg}`) };
    },
  },

  {
    name: "ship_live",
    title: "One ship: live game state vs the fleet's cached view",
    description:
      "Everything about one ship in a single call: its LIVE state from the game API next to the agent's cached snapshot (they can differ for a task cycle — this is the tool for \"the UI says X but the status says Y\"), plus role, held/manual state, current intent, tour destination, keeper pin, dispatcher assignment, and the ship's own recent log lines. Makes one game-API call.",
    input: { ship: z.string(), logs: num(15) },
    async run(ctx, a) {
      const { w } = ctx;
      const live = await w.api.getShip(a.ship);
      const cached = w.fleet.fleetStatusSummary().find((s) => s.symbol === a.ship);
      const dbg = w.fleet.opsShipDebug(a.ship);
      const l: any = live;
      const liveView = {
        nav: l.nav?.status, waypoint: l.nav?.waypointSymbol, system: l.nav?.systemSymbol,
        arrival: l.nav?.status === "IN_TRANSIT" ? l.nav?.route?.arrival : undefined,
        flightMode: l.nav?.flightMode,
        fuel: l.fuel ? `${l.fuel.current}/${l.fuel.capacity}` : undefined,
        cargo: l.cargo ? { units: l.cargo.units, capacity: l.cargo.capacity, items: (l.cargo.inventory ?? []).map((i: any) => `${i.units} ${i.symbol}`) } : undefined,
        cooldown: l.cooldown?.remainingSeconds ? { remainingSeconds: l.cooldown.remainingSeconds, expiration: l.cooldown.expiration } : undefined,
      };
      const diffs: string[] = [];
      if (cached) {
        if (cached.nav !== liveView.nav) diffs.push(`nav: cached ${cached.nav} vs live ${liveView.nav}`);
        if (cached.waypoint !== liveView.waypoint) diffs.push(`waypoint: cached ${cached.waypoint} vs live ${liveView.waypoint}`);
        if (cached.fuel !== l.fuel?.current) diffs.push(`fuel: cached ${cached.fuel} vs live ${l.fuel?.current}`);
      }
      const lines = logBuffer.query({ tenantId: w.tenantId, ship: a.ship, limit: Math.min(a.logs, 100) });
      return {
        asOf: iso(ctx.now()),
        live: liveView,
        cached: cached ? { role: cached.role, nav: cached.nav, waypoint: cached.waypoint, fuel: `${cached.fuel}/${cached.fuelCap}`, doing: cached.doing, wants: cached.wants, wantsReason: cached.wantsReason } : "not in the fleet's role maps",
        cacheDiffersFromLive: diffs,
        fleet: dbg,
        recentLogs: lines.map((x) => `${iso(x.at).slice(11, 19)} ${x.msg}`),
      };
    },
  },

  {
    name: "stuck",
    title: "Ships that look wrong right now",
    description:
      "Severity-ranked findings: stranded, out of fuel, low fuel, transit whose arrival has passed, agent snapshot trailing the polled game state, suspended agents. Reads in-memory state only (no game-API calls). Zero-tank keepers are exempt from fuel checks.",
    input: {},
    async run(ctx) {
      const { w } = ctx;
      const summary = w.fleet.fleetStatusSummary() as SummaryShip[];
      const stranded = new Set(w.fleet.getStrandedShips().map((s: { symbol: string }) => s.symbol));
      const findings = classifyShips(summary, stateShips(ctx), stranded, ctx.now());
      const counts = { crit: 0, warn: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      return { asOf: iso(ctx.now()), ships: summary.length, counts, findings };
    },
  },

  {
    name: "contract_money",
    title: "Contract money: realized and still owed",
    description:
      "What contracts have earned and cost over a window (advances and payouts received, units delivered and their cost basis, net per contract, contract income as a share of all income, and the headline net with contracts included), plus the pipeline of accepted contracts still to be paid: what each owes on completion, progress, cost so far, estimated cost to finish, expected net and time left. The owed figure is not cash and is never part of credits or net.",
    input: { sinceHours: num(24) },
    async run(ctx, a) {
      const now = ctx.now();
      const since = iso(now - a.sinceHours * 3_600_000);
      const rows = await ctx.w.store.ledgerRowsSince(ctx.w.tenantId, since);
      const m = buildMetrics(rows, { now, hours: a.sinceHours, bucketMinutes: bucketMinutesFor(a.sinceHours) });
      const owed = ctx.w.contracts ? await contractsOverview({ contracts: ctx.w.contracts, store: ctx.w.store, tenantId: ctx.w.tenantId, ships: ctx.w.state.get().ships ?? [] }) : null;
      return { window: { since, hours: a.sinceHours }, realized: m.contracts, owed };
    },
  },
  {
    name: "pnl",
    title: "Profit & loss for a window",
    description:
      "The honest way to answer \"how are we doing\": matched trading net (sum of per-sale realized profit — only completed round trips) next to cash flow by ledger type (sells, purchases, fuel, jumps, ships, contracts). The gap between the two is open cargo positions plus non-trade costs. Also per-ship matched-profit leaders and the jump count/cost.",
    input: { sinceHours: num(24) },
    async run(ctx, a) {
      const since = iso(ctx.now() - a.sinceHours * 3_600_000);
      const r = await ctx.w.store.opsPnl(ctx.w.tenantId, since);
      const t = (type: string) => r.byType.find((x) => x.type === type)?.total ?? 0;
      const n = (type: string) => r.byType.find((x) => x.type === type)?.n ?? 0;
      const cashFlow = t("SELL") + t("CONTRACT") - t("PURCHASE") - t("REFUEL") - t("JUMP") - t("SHIP");
      return {
        window: { since, hours: a.sinceHours },
        matchedTradingNet: r.matched.pnl,
        matchedSales: r.matched.sells,
        cashFlow,
        cashFlowBreakdown: { sells: t("SELL"), contracts: t("CONTRACT"), purchases: -t("PURCHASE"), fuel: -t("REFUEL"), jumps: -t("JUMP"), ships: -t("SHIP") },
        jumps: { count: n("JUMP"), total: t("JUMP"), avg: n("JUMP") ? Math.round(t("JUMP") / n("JUMP")) : 0 },
        byType: r.byType,
        topShips: r.byShip,
        note: "cashFlow < matchedTradingNet is expected: it also absorbs ships bought, fuel/jump costs and cargo still held (unsold). Trader jumps before the JUMP ledger type shipped (2026-10-03) were never recorded.",
      };
    },
  },

  {
    name: "ledger",
    title: "Ledger rows",
    description: "Filtered ledger rows, newest first (type: PURCHASE|SELL|REFUEL|JUMP|SHIP|CONTRACT|OTHER). Prices are credits; `realized_pnl` is set only on sells with a tracked cost basis. `wallet_after` is the wallet balance right after the trade (rows from 2026-10-08 20:04 UTC onward). `route` (PURCHASE/SELL rows from the 2026-10-11 deploy) is the trip the trade belonged to: buy>sell waypoints, who chose it (auto/manual) and the circuit leg. resetDate (e.g. 2026-10-11) reads that finished week instead of the current one, over the whole week (sinceHours is ignored); oldestFirst=true returns the earliest rows first, e.g. the first JUMP of a week.",
    input: { ship: z.string().optional(), good: z.string().optional(), type: z.string().optional(), waypoint: z.string().optional(), sinceHours: num(6), limit: num(40), resetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), oldestFirst: bool },
    async run(ctx, a) {
      // A named past week is read under that week's universe key over the whole week; without one, the current week as before.
      const universe = a.resetDate ? universeKey(ctx.w.agentSymbol, a.resetDate) : undefined;
      if (a.resetDate && !universe) throw new Error("resetDate must look like 2026-10-11 (the day the week began)");
      const sinceIso = a.resetDate ? `${a.resetDate}T00:00:00.000Z` : iso(ctx.now() - a.sinceHours * 3_600_000);
      const rows = await ctx.w.store.opsLedger(ctx.w.tenantId, { ship: a.ship, good: a.good, type: a.type, waypoint: a.waypoint, sinceIso, limit: Math.min(a.limit, 300), universe, oldestFirst: a.oldestFirst });
      return { returned: rows.length, ...(universe ? { universeKey: universe } : {}), rows };
    },
  },

  {
    name: "movements",
    title: "Warps and gate jumps",
    description: "Every warp and gate jump the engine made in the window, newest first, kept durably across restarts (table ship_movements). Each warp has the distance, the tank before and after (so the real warp fuel cost is fuel_before - fuel_after, to calibrate WarpPolicy.fuelPerUnit) and the source (trader/tour/fleet). Each jump has its credit cost. `summary` gives counts and totals per kind, so warp-versus-gate use is answered directly. Only moves made from this version on are recorded; earlier moves are not in the table.",
    input: { ship: z.string().optional(), kind: z.enum(["warp", "jump"]).optional(), sinceHours: num(24), limit: num(500) },
    async run(ctx, a) {
      const rows = await ctx.w.store.opsMovements(ctx.w.tenantId, { ship: a.ship, kind: a.kind, sinceIso: iso(ctx.now() - a.sinceHours * 3_600_000), limit: Math.min(a.limit, 2000) });
      const warps = rows.filter((r) => r.kind === "warp");
      const jumps = rows.filter((r) => r.kind === "jump");
      const warpUnits = warps.reduce((t, r) => t + Number(r.distance ?? 0), 0);
      const warpFuel = warps.reduce((t, r) => t + (Number(r.fuel_before) - Number(r.fuel_after)), 0);
      const jumpCost = jumps.reduce((t, r) => t + Number(r.cost ?? 0), 0);
      return {
        window: { since: iso(ctx.now() - a.sinceHours * 3_600_000), hours: a.sinceHours },
        summary: {
          warps: warps.length,
          gateJumps: jumps.length,
          warpDistanceUnits: Math.round(warpUnits),
          warpFuelUsed: warpFuel,
          warpFuelPerUnit: warpUnits > 0 ? Number((warpFuel / warpUnits).toFixed(3)) : null,
          gateJumpCost: jumpCost,
        },
        returned: rows.length,
        rows,
      };
    },
  },

  {
    name: "analysis",
    title: "What worked, what didn't, and why",
    description:
      "The analysis engine over a window (docs/analysis-engine.md): every trip rebuilt from the ledger and joined with the estimate the bot chose it on, per-route results (best and worst, profit per trip and per loaded hour, positioning cost), how hard our own trades move each market and how long it takes to recover, who caused each big price move (us, another agent, or nobody seen), what each settings change was followed by (a correlation with its sample size, not proof), calibration factors (realized over estimated profit, the first step to prediction), and ranked findings with suggested actions (exact tool and arguments where one exists; advisory only, nothing is applied). Also a `freshness` block: profit per unit sold by hours since a system gained keeper coverage (0-2h, 2-4h, 4-8h, 8-16h, 16h+) against the mature rate, the systems that yielded most with their own first and last bucket, and when the premium fades; the age is measured from the keeper-list change, so read it as a correlation. Estimates exist only for trips from the 2026-10-15 deploy on.",
    input: { sinceHours: num(24) },
    async run(ctx, a) {
      return runAnalysis(ctx.w, Math.min(Math.max(1, a.sinceHours), 24 * 8), ctx.now());
    },
  },

  {
    name: "findings_history",
    title: "Saved analysis reports",
    description: "Analysis reports saved with stcommand_capture_findings (table analysis_findings), newest first. Kept across the weekly reset, so last week's lessons can be compared with this week's. Pass id for one full report; without it, only the headers.",
    input: { id: z.coerce.number().optional(), limit: num(20) },
    async run(ctx, a) {
      const rows = await ctx.w.store.listAnalysisFindings(ctx.w.tenantId, { id: a.id, limit: a.limit, withReport: a.id !== undefined });
      return { returned: rows.length, rows };
    },
  },

  {
    name: "deadhead",
    title: "Loaded vs empty time",
    description: "How much of each ship's time is spent carrying cargo, from the ledger: loaded from a ship's first buy until its hold is sold down, empty otherwise (flying to a buy, docking, repositioning). Per ship: loaded share, trips, realized profit and profit per loaded hour; plus the fleet roll-up. The baseline for the backhaul / follow-on work (docs/backhaul-plan.md). Ledger-only, so a window that opens mid-trip assumes the ship was already loaded.",
    input: { sinceHours: num(3) },
    async run(ctx, a) {
      const to = ctx.now();
      const from = to - a.sinceHours * 3_600_000;
      const rows = await ctx.w.store.opsTradeRows(ctx.w.tenantId, iso(from));
      const r = deadheadFromTrades(
        rows.map((x) => ({ shipSymbol: x.ship_symbol, type: x.type as "PURCHASE" | "SELL", units: Number(x.units), timestampMs: new Date(x.timestamp).getTime(), total: Number(x.total), realizedPnl: x.realized_pnl === null ? null : Number(x.realized_pnl) })),
        from,
        to,
      );
      return {
        window: { since: iso(from), hours: a.sinceHours },
        fleet: { loadedShare: Math.round(r.fleet.loadedShare * 100) / 100, pnl: r.fleet.pnl, pnlPerLoadedHour: r.fleet.pnlPerLoadedHour },
        ships: r.ships.map((s) => ({ shipSymbol: s.shipSymbol, loadedShare: Math.round(s.loadedShare * 100) / 100, loadedMin: Math.round(s.loadedMs / 60_000), emptyMin: Math.round(s.emptyMs / 60_000), trips: s.trips, pnl: s.pnl, pnlPerLoadedHour: s.pnlPerLoadedHour })),
      };
    },
  },

  {
    name: "keepers",
    title: "Keeper coverage per market",
    description:
      "For every market with a keeper pinned or on the priority list: covered (a keeper is physically there), enroute (pinned but still flying or waiting at its shipyard), staged (parked there, waiting for its system to be released), parked (parked there by triage as low value), or pending (listed, nobody assigned); lists duplicates (more than one keeper on a market — wasted probes) and uncovered priority markets. Optionally restrict to one system.",
    input: { system: z.string().optional() },
    async run(ctx, a) {
      const { w } = ctx;
      const inSystem = (m: string) => !a.system || m.startsWith(`${a.system}-`);
      const stations = (w.fleet.keeperStations() as { shipSymbol: string; market: string; parked?: "staged" | "triage" | "idle" }[]).filter((s) => inSystem(s.market));
      const priority = (await w.fleet.keeperPriorityMarkets()).filter(inSystem);
      const rep = keeperReport(stations, stateShips(ctx), priority);
      const counts = { covered: 0, enroute: 0, staged: 0, parked: 0, pending: 0 };
      for (const m of rep.markets) if (m.status in counts) counts[m.status as keyof typeof counts]++;
      return { asOf: iso(ctx.now()), counts, duplicates: rep.duplicates, uncoveredPriority: rep.uncoveredPriority, markets: rep.markets };
    },
  },

  {
    name: "profile",
    title: "Where the server's CPU and memory go",
    description:
      "Profile this server process in place. action=status: memory, V8 heap, event-loop delay (is it CPU-bound?). action=cpu (seconds, default 15, max 30): self time by function and by file while it runs. action=heap_start then, minutes later, heap_report: bytes still live that were allocated since the start, by allocating function and call stack (what is growing); heap_stop when done. Read-only apart from the sampling overhead; do not leave the heap sampling running for hours.",
    input: { action: z.enum(["status", "cpu", "heap_start", "heap_report", "heap_stop"]).optional().default("status"), seconds: num(15) },
    async run(_ctx, a) {
      switch (a.action) {
        case "cpu": return profileCpu(a.seconds);
        case "heap_start": return heapStart();
        case "heap_report": return heapReport();
        case "heap_stop": return heapStop();
        default: return runtimeStatus();
      }
    },
  },

  {
    name: "instances",
    title: "Server instances & rate-limit status",
    description:
      "Is an old server instance still running, and are we being rate limited? Lists instances seen in the last few hours from the heartbeat table (aliveNow = checked in within 40s — more than one alive means deploy overlap, the usual cause of a 429 storm), this process's id and uptime, and the rolling-minute 429 count.",
    input: { hours: num(6) },
    async run(ctx, a) {
      const instances = await ctx.w.store.opsInstances(a.hours);
      const alive = instances.filter((i) => i.aliveNow);
      return {
        asOf: iso(ctx.now()),
        thisInstance: INSTANCE_ID,
        uptimeMin: Math.round(process.uptime() / 60),
        rateLimit: rateLimitMonitor.snapshot(),
        aliveCount: alive.length,
        overlap: alive.length > 1,
        instances,
      };
    },
  },

  {
    name: "timeline",
    title: "Fleet timeline: roles, purchases, approvals, operator actions",
    description:
      "The fleet's story in time order, merged from fleet_events (every role change incl. ones the engine made itself, every ship purchase, approval requested/decided) and operator_actions (everything you did). Survives the weekly reset. Filters: sinceHours, ship, kinds (comma list: role_change, ship_purchased, approval_requested, approval_decided, plus operator kinds like role_change/manual_buy/mcp_*), resetDate (a past week). Set samples=true to also return the 15-minute credits/ship-count/role-mix curve.",
    input: { sinceHours: z.coerce.number().optional(), ship: z.string().optional(), kinds: z.string().optional(), resetDate: z.string().optional(), limit: num(200), samples: bool },
    async run(ctx, a) {
      const sinceIso = a.sinceHours ? iso(ctx.now() - a.sinceHours * 3_600_000) : undefined;
      const kinds = a.kinds ? String(a.kinds).split(",").map((k: string) => k.trim()).filter(Boolean) : undefined;
      const events = await ctx.w.store.opsTimeline(ctx.w.agentSymbol, { sinceIso, resetDate: a.resetDate, kinds, ship: a.ship, limit: a.limit });
      const out: Record<string, unknown> = { asOf: iso(ctx.now()), count: events.length, events };
      if (a.samples) out.samples = await ctx.w.store.listRunTimeline(ctx.w.agentSymbol, { sinceIso, resetDate: a.resetDate, limit: 700 });
      return out;
    },
  },

  {
    name: "reset_watch",
    title: "Server-reset recovery status",
    description:
      "State of the automatic post-reset recovery (save scoreboard, clear stale data, register a fresh agent, boot): the game's published resetDate and next scheduled reset, the last resetDate this server finished handling, and per-tenant progress. state needs_account_token = a reset was detected but ST_ACCOUNT_TOKEN is not set, so nothing was changed.",
    input: {},
    async run(ctx) {
      return {
        asOf: iso(ctx.now()),
        watcher: resetWatcherStatus() ?? null,
        accountTokenConfigured: Boolean(process.env.ST_ACCOUNT_TOKEN),
      };
    },
  },

  {
    name: "run_results",
    title: "Weekly scoreboard (one row per agent per reset)",
    description:
      "The run_results table: one row per agent per server-reset period with cash in hand at the end, wallet delta, matched trading net, ship count and roles, fuel/jump/ship spend, top ships and goods, doctrine in force and operator interventions. Rows are written automatically just before a reset wipes the data. Pass captureNow=true to also record a refreshable mid-week snapshot for the current universe (kind 'manual' — writes only this scoreboard table, never touches game state or the end-of-week row).",
    input: { limit: num(10), captureNow: bool, resetDate: z.string().optional() },
    async run(ctx, a) {
      let captured: boolean | undefined;
      if (a.captureNow) {
        captured = await ctx.w.store.captureRunResult(ctx.w.tenantId, ctx.w.agentSymbol, a.resetDate ?? "current", { kind: "manual", notes: "manual mid-week capture" });
      }
      return { asOf: iso(ctx.now()), captured, rows: await ctx.w.store.listRunResults(a.limit) };
    },
  },

  {
    name: "mining_fields",
    title: "Minable asteroid fields: deposit mix, distance, who is on them",
    description:
      "Every minable asteroid (ASTEROID and ENGINEERED_ASTEROID) in the home system with its measured deposit mix from our surveys (percent of listed deposits by good, largest first), how many surveys that rests on (`reliable` needs 10+; `surveyed: false` means we have never surveyed it, so send a surveyor with scan_fields), its distance to `target` (e.g. the market the ore goes to) when given, and which miners are pinned and which feeds/collectors use it. Pass `good` to rank by that deposit's share (ties by nearness to `target`), otherwise nearest first. Plain rows so the same data can drive automatic field choice later.",
    input: { target: z.string().optional(), good: z.string().optional(), sinceHours: num(168) },
    async run(ctx, a) {
      const { w } = ctx;
      const system = w.fleet.homeSystem;
      const waypoints = ((w.state.get() as { waypoints?: FieldWaypoint[] }).waypoints ?? []).filter((x) => x.symbol.startsWith(`${system}-`));
      const tallies = await w.store.fieldComposition({ systemSymbol: system, since: iso(ctx.now() - a.sinceHours * 3_600_000) });
      const pins = w.fleet.getShipStatuses().flatMap((s: { symbol: string; pinnedField?: string }) => (s.pinnedField ? [{ ship: s.symbol, field: s.pinnedField }] : []));
      const feeds = (await w.fleet.getFeeds()) as { good: string; targetWaypoint: string; field?: string; collector?: string }[];
      const fields = miningFieldsReport({ waypoints, tallies, pins, feeds, target: a.target, good: a.good });
      return {
        system, target: a.target, good: a.good?.toUpperCase(), sinceHours: a.sinceHours,
        note: "shares are percent of listed deposits across surveys; distance is straight-line in system units. Only the home system's waypoints are known here.",
        unsurveyed: fields.filter((f) => !f.surveyed).map((f) => f.waypoint),
        fields,
      };
    },
  },

  {
    name: "survey_candidates",
    title: "Where to send a scout/tour next",
    description:
      "Systems within N gate hops of `from`, ranked by how much market data is missing: market count, shipyards, how many markets have ever been priced, newest price, hop distance, and whether the gate out of each system is complete (an incomplete gate means the system is not actually reachable). Skips systems below minMarkets.",
    input: { from: z.string(), maxHops: num(2), minMarkets: num(8), limit: num(12) },
    async run(ctx, a) {
      const graph = await ctx.w.store.opsGalaxyGraph();
      const gates = await ctx.w.store.opsGateStatus();
      const bySys = new Map(graph.map((g) => [g.system, g]));
      const adj = new Map<string, string[]>();
      for (const g of graph) adj.set(g.system, [...new Set(g.gates.flatMap((x) => x.to))]);
      const hops = hopsWithin(adj, a.from, Math.min(a.maxHops, 5));
      const rows = [...hops.entries()]
        .filter(([sys]) => sys !== a.from)
        .map(([sys, h]) => {
          const g = bySys.get(sys);
          const gateSyms = g?.gates.map((x) => x.gate) ?? [];
          const complete = gateSyms.length ? gateSyms.every((s) => gates.get(s) !== false) : undefined;
          return { system: sys, hops: h, markets: g?.markets ?? 0, shipyards: g?.shipyards ?? 0, priced: g?.priced ?? 0, unpriced: (g?.markets ?? 0) - (g?.priced ?? 0), newestPrice: g?.newest ?? null, gateComplete: complete };
        })
        .filter((r) => r.markets >= a.minMarkets)
        .sort((x, y) => Number(y.gateComplete !== false) - Number(x.gateComplete !== false) || y.unpriced - x.unpriced || x.hops - y.hops)
        .slice(0, Math.min(a.limit, 50));
      return { from: a.from, maxHops: a.maxHops, note: "Ranked: reachable first, then most unpriced markets, then nearest. gateComplete=false means a gate in that system is still under construction.", candidates: rows };
    },
  },

  {
    name: "systems_candidates",
    title: "Candidate systems to move a ship into (advisory)",
    description:
      "Systems ranked by how good they are to trade in next, with the reasons: gate hops from our ships, whether the gates are finished, profitable same-system routes and their best trip profit, and whether a yard sells a trading hull. A system nobody has surveyed is listed as a survey target, since its markets and yards are unknown until a ship visits. Criteria are the defaults in engine/systems/candidates.ts; override any with the inputs. Advisory only: nothing is moved or bought.",
    input: { maxHops: num(2), minLocalRoutes: num(1), requireHullYard: z.preprocess((v) => v === true || v === "1" || v === "true", z.boolean()).default(false) },
    async run(ctx, a) {
      const result = await systemCandidates(ctx.w, { ...DEFAULT_CANDIDATE_POLICY, maxHops: a.maxHops, minLocalRoutes: a.minLocalRoutes, requireHullYard: a.requireHullYard });
      return result;
    },
  },

  {
    name: "blocked_goods",
    title: "Blocked trade goods",
    description: "The operator's blocked-goods list: goods no trader buys for margin trading and the dispatcher drops from the route list, with when each was blocked and why. Change it with stcommand_block_good / stcommand_unblock_good.",
    input: {},
    async run(ctx) {
      const blocked = await ctx.w.fleet.blockedGoodsEntries();
      return { count: blocked.length, blocked };
    },
  },

  {
    name: "parked",
    title: "Parked ships",
    description: "Every parked hull (kept, not flying, no API calls): where it sits, what it will resume as, the keeper market it covers, and any cargo frozen aboard. Park and unpark with stcommand_park_ship / stcommand_unpark_ship.",
    input: {},
    async run(ctx) {
      const parked = ctx.w.fleet.parkedList();
      return { count: parked.length, parked };
    },
  },

  {
    name: "keeper_review",
    title: "Keeper review: value per keeper, polling cost, what to buy next, what to scrap",
    description: "Each keeper's market scored on what it trades (imports, exports and exchanges weighted by typical price, goods we have a route for counting more), so the weakest stationed keepers and the best uncovered markets can be compared. Gives the keeper count against the keeperMaxTotal limit, the API calls a minute the keepers cost now and at the limit (the fleet may make about 90 a minute), the uncovered markets in the order they would be bought, and swap suggestions where an uncovered market clearly beats a stationed keeper. Advisory only: nothing is scrapped or bought. To act, park the weak keeper with stcommand_park_ship (it stops polling at once, keeps its hull, and frees a slot under the keeper limit; its market stays marked covered, so it is not bought again) or scrap it with stcommand_sell_ship (it flies to a yard and is scrapped for part of its price, and its market becomes uncovered), then the queue buys the better market.",
    input: {},
    async run(ctx) {
      const d = await ctx.w.fleet.keeperReviewData();
      return buildKeeperReview({ nowIso: new Date(ctx.now()).toISOString(), ...d });
    },
  },

  {
    name: "agent_watch",
    title: "Agent watch: who registered when, what their start looked like, how fast start gates get built",
    description: "The public agent directory watched every 15 minutes (agent_sightings, agent_samples, gate_progress_samples; kept across resets). Per agent: its faction, start system, how many agents shared that start, when it was FIRST SEEN and how sure that is (source live = it appeared between two scans, so registration is bracketed by priorScanAt..firstSeenAt; snapshot = from the hourly agent snapshots, so within an hour; baseline = already there when the watcher first ran, so firstSeenAt is only an upper bound), credits and ships then and now, and the start gate's progress at first sight (fulfilled/required, complete) and now, with when it finished. The public API shows no registration time, so this is the only source of one. Filter with agent (part of a name, e.g. FIRST for FIRST and FIRST496), system, sinceHours (first seen within the last N hours; baseline rows excluded) and resetDate (a past week). Also gives sightings by source, new agents per hour, and the hours each start gate took from the first sample to complete. Read-only.",
    input: { agent: z.string().optional(), system: z.string().optional(), resetDate: z.string().optional(), sinceHours: z.coerce.number().optional(), limit: num(60) },
    async run(ctx, a) {
      const resets = await ctx.w.store.agentWatchResets();
      const resetDate = a.resetDate ?? resets[0];
      if (!resetDate) return { note: "the agent watcher has recorded nothing yet (it scans every 15 minutes once the server is up; AGENT_WATCH=off disables it)", resets };
      const all = await ctx.w.store.loadAgentSightings(resetDate);
      const nowMs = ctx.now();
      const inSystemNow = new Map<string, number>();
      for (const s of all) inSystemNow.set(s.system, (inSystemNow.get(s.system) ?? 0) + 1);
      const needle = a.agent?.toLowerCase();
      let rows = all.filter((s) => (!needle || s.agent.toLowerCase().includes(needle)) && (!a.system || s.system === a.system.toUpperCase()));
      if (a.sinceHours !== undefined) rows = rows.filter((s) => s.source !== "baseline" && s.firstSeenAt >= nowMs - a.sinceHours * 3_600_000);
      const matched = rows.length;
      rows = rows.slice(0, Math.min(Math.max(a.limit, 1), 300));
      const gateSamples = await ctx.w.store.gateSamplesForSystems(resetDate, [...new Set(all.map((s) => s.system))]);
      const bySystem = new Map<string, typeof gateSamples>();
      for (const g of gateSamples) (bySystem.get(g.system) ?? bySystem.set(g.system, []).get(g.system)!).push(g);
      const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
      const gateView = (g: { sampledAt: number; fulfilled: number; required: number; complete: boolean } | undefined) => (g ? { fulfilled: g.fulfilled, required: g.required, complete: g.complete, sampledAt: iso(g.sampledAt) } : null);
      const out = rows.map((s) => {
        const samples = bySystem.get(s.system) ?? [];
        const built = gateBuildTime(samples);
        return {
          agent: s.agent, faction: s.faction ?? null, system: s.system, source: s.source,
          firstSeenAt: iso(s.firstSeenAt), registeredAfter: iso(s.priorScanAt),
          agentsInSystemAtFirstSeen: s.agentsInSystem || null, agentsInSystemNow: inSystemNow.get(s.system) ?? 0,
          credits: { atFirstSeen: s.firstCredits, now: s.lastCredits }, ships: { atFirstSeen: s.firstShips, now: s.lastShips },
          gateAtFirstSeen: gateView(gateAtOrBefore(samples, s.firstSeenAt)), gateNow: gateView(samples[samples.length - 1]),
          gateCompletedAt: built ? iso(built.completedAt) : null,
        };
      });
      const perHour = new Map<string, number>();
      for (const s of all) if (s.source === "live") { const h = new Date(s.firstSeenAt).toISOString().slice(0, 13) + ":00Z"; perHour.set(h, (perHour.get(h) ?? 0) + 1); }
      const bySource: Record<string, number> = {};
      for (const s of all) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
      const builds = [...bySystem].map(([system, samples]) => ({ system, ...gateBuildTime(samples) })).filter((b) => b.hours !== undefined) as { system: string; hours: number; firstAt: number; completedAt: number }[];
      builds.sort((x, y) => x.hours - y.hours);
      const hours = builds.map((b) => b.hours).sort((p, q) => p - q);
      return {
        resetDate, resets, lastScan: iso(Math.max(0, ...all.map((s) => s.lastSeenAt))) , agents: all.length, matched, returned: out.length,
        bySource, newPerHour: Object.fromEntries([...perHour].sort()),
        gateBuilds: { systemsWithATimeline: builds.length, medianHours: hours.length ? hours[Math.floor((hours.length - 1) / 2)] : null, fastest: builds.slice(0, 10).map((b) => ({ system: b.system, hours: b.hours, completedAt: iso(b.completedAt) })) },
        note: "gate timelines start at the watcher's first sample of a gate, not at the reset, so hours is time observed to finish; a gate already finished at first sample has no timeline.",
        rows: out,
      };
    },
  },

  {
    name: "system_queue",
    title: "Fresh systems: the queue, the gate, and what the release rule says now",
    description: "The fresh-system queue (doctrine freshGate, off by default): each system an explorer found worth covering as scouted (nothing bought, routes through it not offered to traders), staged (keepers bought and parked on its top markets; the gate is still shut) or live (released; the freshness clock runs from the release), with its markets, how many keepers are in place, and any operator hold. Also the settings in force (target live systems, lead time, fade age), the live systems with their recent profit per unit over the mature rate and sells, the idle traders, and what the release rule would stage or release now with a reason for each (or why not). In advisory mode (freshGate 1) you act on it with stcommand_stage_system, stcommand_release_system and stcommand_hold_system; in auto (2) the engine does. Read-only.",
    input: {},
    async run(ctx) {
      return ctx.w.fleet.freshGateState();
    },
  },

  {
    name: "keeper_triage",
    title: "Keeper triage: keepers the engine parked, its reminders, and what it decided",
    description: "The engine's own keeper management (doctrine keeperTriage, off by default): the keepers it parked because no viable route touches their market (never traded and scoring under half the median, or quiet for 6 hours; all routes held back as dead = a crashed market), each with when it was parked, how many looks found the market still dead and whether it was settled (left parked for good, a candidate to scrap); the reminders it set itself with their due times; and the last decisions it made, each with its reason. Read-only. To override: unpark with stcommand_unpark_ship (its reminder is dropped on the next pass) or turn the clause off (reminders keep running, so parked keepers still come back).",
    input: {},
    async run(ctx) {
      return ctx.w.fleet.keeperTriageState();
    },
  },

  {
    name: "keeper_sales",
    title: "Keepers at markets where we have made no sales",
    description: "Every stationed keeper with how many sells and buys of ours (count and credits) have happened at its market this week, lowest first. By default only the keepers whose market has seen none of our sales (noTrade counts those with no buys either): price listening that no route of ours uses, the first candidates to scrap or park when the keeper limit is full. A market with no sales can still matter if traders buy there or its prices inform routes, so check buys and the keeper review score before scrapping. Set onlyNoSales=false for every keeper.",
    input: { onlyNoSales: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional().default(true) },
    async run(ctx, a) {
      const [review, trades] = await Promise.all([ctx.w.fleet.keeperReviewData(), ctx.w.store.ledgerTradeByWaypoint(ctx.w.tenantId)]);
      return keeperSales(review.stationed, trades, a.onlyNoSales);
    },
  },

  {
    name: "rival_activity",
    title: "Rival activity: what other agents trade at the markets we watch",
    description: "Other agents' fills at markets our ships or keepers have scanned, grouped by agent (the ship symbol without its last suffix): ships, visits, units bought and sold, the median and largest load per visit (about their hold size), the goods and markets they trade most. A visit joins one ship's fills at one market that are under three minutes apart. A floor, not a census: a scan shows only the recent fills, and an agent only appears where we look. Filter with agent (a name or part of one, for example POPEX or TIPTAP), minUnits and limit. Read-only; sinceHours is capped at 168.",
    input: { sinceHours: num(24), agent: z.string().optional(), minUnits: num(0), limit: num(25) },
    async run(ctx, a) {
      const hours = Math.min(Math.max(a.sinceHours, 0.25), 168);
      const fills = await ctx.w.store.rivalMarketFills(ctx.w.agentSymbol, new Date(ctx.now() - hours * 3_600_000).toISOString());
      return { window: { sinceHours: hours, rowsRead: fills.length, capped: fills.length >= 200000 }, ...rivalActivity(fills, { agentFilter: a.agent, minUnits: a.minUnits, limit: Math.min(Math.max(a.limit, 1), 100) }) };
    },
  },

  {
    name: "chart_rewards",
    title: "What charting a waypoint has paid",
    description: "The one-time credit reward for charting a waypoint, measured from our own books: every ledger row records the balance right after it, so between two consecutive rows the balance should move by exactly the second row's effect, and a chart that happened in that gap explains any leftover. Reports the charts in the window, a self-check (gaps with no chart should leave exactly nothing over: baseline.exactShare near 1 means the books are tight and the chart figures can be trusted), the single-chart rewards (median, mean, min, max) and the largest ones with the traits charted. Gaps holding several charts are averaged. Read-only; sinceHours defaults to 72.",
    input: { sinceHours: num(72) },
    async run(ctx, a) {
      const sinceIso = new Date(ctx.now() - Math.min(Math.max(a.sinceHours, 1), 336) * 3_600_000).toISOString();
      const [charts, track] = await Promise.all([ctx.w.store.chartActivity(ctx.w.tenantId, sinceIso), ctx.w.store.ledgerWalletTrack(ctx.w.tenantId, sinceIso)]);
      return { sinceIso, ledgerRows: track.length, ...chartRewardReport(track, charts) };
    },
  },

  {
    name: "explorers",
    title: "Explorers: what they are doing, systems looked at, keepers bought",
    description: "Each explorer ship (where it is, fuel, what it is doing, any interrupted tour, its recent jumps and the systems it visited with their verdict), the newest survey marks (rejected = under the worth threshold, surveyed = a real survey, atlas = seeded from the galaxy atlas, with markets, shipyards and how many keepers stand there) and the keepers bought in the window with where they were stationed. Read-only. This is the data behind Deck's Fleet › Explorers tab.",
    input: { sinceHours: num(72) },
    async run(ctx, a) {
      return explorerReport(ctx.w, Math.min(Math.max(a.sinceHours, 1), 720), ctx.now());
    },
  },

  {
    name: "yard_scan",
    title: "Hulls on offer, ranked by cargo x speed per credit",
    description: "Every ship type seen in the shipyards we have read, at its cheapest yard: hold (from the fitted cargo modules, since the yard's own cargo figure is often 0), engine speed, fuel, price, how many yards offer it, how old the reading is, and a score = hold x speed per 1,000 credits. fastAndAffordable lists the hulls faster than fastAbove (default 15, the common light hulls) at or under affordableUnder (default 1,000,000), the answer to \"is there a cheap fast ship\". Route times are costed at the slowest hull, so speed is worth most on same-system routes: see the shipSpeedWeight clause. Only yards we have read are listed; the explorers add more. Read-only.",
    input: { fastAbove: num(DEFAULT_YARD_POLICY.fastAbove), affordableUnder: num(DEFAULT_YARD_POLICY.affordableUnder), limit: num(DEFAULT_YARD_POLICY.limit) },
    async run(ctx, a) {
      const intel = await ctx.w.fleet.getIntel();
      return yardReport(intel.shipyards, ctx.now(), { fastAbove: a.fastAbove, affordableUnder: a.affordableUnder, limit: Math.min(Math.max(a.limit, 1), 60) });
    },
  },

  {
    name: "market_directory",
    title: "What each surveyed market trades, ranked, with keeper coverage",
    description: "The goods lists (imports, exports, exchange) a survey read remotely for every market of a system, saved when the survey ran. No ship has to have stood there and there are no prices: the number of distinct goods is the signal for where a keeper is worth sending. Also each yard's hull-type list and whether it sells probes (yards). Per system: markets, how many already have a keeper, how many have at least minGoods goods and no keeper (worthKeeping), and the markets best first. Filter with system. Read-only.",
    input: { system: z.string().optional(), minGoods: num(5), limit: num(40) },
    async run(ctx, a) {
      const [rows, yardRows] = await Promise.all([ctx.w.store.marketDirectory(a.system), ctx.w.store.shipyardDirectory(a.system)]);
      const covered = new Set(ctx.w.fleet.keeperStations().map((k) => k.market));
      const systems = summarizeDirectory(rows, covered, ctx.now(), a.minGoods);
      const yardsBySystem = new Map<string, { yard: string; sellsProbes: boolean; types: number }[]>();
      for (const y of yardRows) yardsBySystem.set(y.systemSymbol, [...(yardsBySystem.get(y.systemSymbol) ?? []), { yard: y.waypointSymbol, sellsProbes: y.shipTypes.includes("SHIP_PROBE"), types: y.shipTypes.length }]);
      return { systems: systems.length, rows: rows.length, list: systems.slice(0, Math.min(Math.max(a.limit, 1), 200)).map((s) => ({ ...s, yards: yardsBySystem.get(s.system) ?? [], ranked: a.system ? s.ranked : s.ranked.slice(0, 6) })) };
    },
  },

  {
    name: "market_freshness",
    title: "Every market in a system with price age",
    description: "All marketplaces in a system: goods priced, newest snapshot and its age in minutes (null = never priced), freshest first. Routes only use snapshots newer than the freshness cutoff (90 min by default), so an old age here explains a route that never appears.",
    input: { system: z.string() },
    async run(ctx, a) {
      const rows = await ctx.w.store.opsMarketFreshness(a.system);
      return { system: a.system, markets: rows.length, neverPriced: rows.filter((r) => r.newest === null).length, staleOver90min: rows.filter((r) => r.ageMin !== null && r.ageMin > 90).length, rows };
    },
  },

  {
    name: "assignments",
    title: "Dispatcher assignments",
    description: "The route dispatcher's current per-ship assignments, manual overrides included (source=manual). For the *reasoning* behind who got what, see dispatch_explain (phase 2, docs/ops-layer-design.md).",
    input: {},
    async run(ctx) {
      const list = ctx.w.fleet.dispatcher.list();
      return { asOf: iso(ctx.now()), count: list.length, assignments: list };
    },
  },
  {
    name: "dispatch_explain",
    title: "Why the dispatcher picked what it picked",
    description:
      "The route dispatcher's last cycle (refreshed about once a minute): the ranked work list with each route's claimant, the routes dropped under the margin floor, and for each trader the reason it was refused each route it was checked against — already claimed, declined, out of reach, buyer cap, margin gone after impact, net score, or outscored by a named route. Filter by ship and/or good to see one ship's or one route's reasons. Busy traders show their assignment without rejections. notConsidered lists traders the dispatcher is never offered (held, suspended, claimed by a mission or feed, warehouse) with the reason: check it first when a trader sits idle next to good routes. A route that never reached the work list (no open gate, or its market already being sold into) is not listed.",
    input: { ship: z.string().optional(), good: z.string().optional(), limit: num(30) },
    async run(ctx, a) {
      const snap = ctx.w.fleet.dispatcher.explain();
      // routeBuild explains the route list itself: legs dropped before the dispatcher, by reason, with a sample.
      const routeBuild = ctx.w.fleet.routeBuildReport();
      // Traders the dispatcher is never offered (held, suspended, claimed): they have no per-route rejections to show.
      const notConsidered = ctx.w.fleet.dispatchExclusions().filter((e) => a.ship === undefined || e.ship === a.ship);
      if (!snap) return { note: "The dispatcher has not completed a cycle since this process started.", notConsidered, routeBuild };
      return { ...selectExplain(snap, { ship: a.ship, good: a.good, limit: a.limit }), notConsidered, routeBuild };
    },
  },
  {
    name: "circuit_log",
    title: "Two-leg circuits: how far each got, and why the rest were dropped",
    description:
      "The circuit lifecycle since the process started: counters (planned, leg 1 sold, leg 2 served, leg 2 bought and flying, completed, and dropped by reason), the circuits still open with how long ago each was planned, had leg 1 sold and had leg 2 served, and the most recent events with timestamps (planned, leg 1 sold, leg 2 served, leg 2 loaded, completed, dropped with the reason). Use it to answer whether second legs ever run: a circuit that is planned but never served is only a ranking boost. Dropped reasons separate a leg that left the board from one still on it but refused for the ship.",
    input: { limit: num(40) },
    async run(ctx, a) {
      const c = ctx.w.fleet.dispatcher.circuitLog();
      const events = c.events.slice(-a.limit).map((e) => ({ at: iso(e.at), ship: e.ship, event: e.event, text: e.text }));
      return { counts: c.counts, open: c.open, events };
    },
  },
  {
    name: "attention",
    title: "Ships that need a person's eyes, and why",
    description:
      "The attention feed: each ship that needs looking at, most urgent first, with the reasons. Plain rules raise the clear cases (stranded, a hold replayed from saved state at boot rather than placed this session, a ship repeating one log line, a long silence, overdue transit, low fuel); when a decision-model key is set, literal yes/no questions about the ships that look worth a second opinion can add the model's own flags, each labelled with its probability. Advisory only, switched on by the 'Attention feed' doctrine clause (off returns an empty list). Refreshes about once a minute.",
    input: {},
    async run(ctx) {
      const snap = ctx.w.fleet.attention.snapshot();
      return { asOf: snap.asOf ? iso(snap.asOf) : null, enabled: snap.enabled, modelConfigured: snap.modelConfigured, askedLastPass: snap.asked, failedLastPass: snap.failed, count: snap.items.length, items: snap.items };
    },
  },
  {
    name: "judge_decisions",
    title: "What the decision model answered, for checking its calibration",
    description:
      "The decision-model log, newest first: for each answered question the feature (router or attention), what it was about (a ship symbol, or the captain's message with secrets redacted), the question, the model's answer and confidence, whether the answer changed what the engine did (acted) or was only logged, and the model and latency. The vendor's own figures are unverified, so this is the evidence for deciding how far to trust it: compare confidences with what actually happened.",
    input: { feature: z.enum(["router", "attention"]).optional(), sinceMin: num(240), limit: num(60) },
    async run(ctx, a) {
      const rows = await ctx.w.store.recentJudgeDecisions(ctx.w.tenantId, { feature: a.feature, sinceIso: iso(ctx.now() - a.sinceMin * 60_000), limit: Math.min(a.limit, 300) });
      return { asOf: iso(ctx.now()), returned: rows.length, decisions: rows };
    },
  },
];

export const OPS_BY_NAME = new Map(OPS_TOOLS.map((t) => [t.name, t]));
