import * as z from "zod";
import { logBuffer } from "../core/logBuffer.js";
import { INSTANCE_ID, rateLimitMonitor } from "../core/rateLimitMonitor.js";
import { classifyShips, hopsWithin, keeperReport, type StateShip, type SummaryShip } from "./classify.js";
import { resetWatcherStatus } from "../engine/resetWatcher.js";
import { deadheadFromTrades } from "../engine/deadhead.js";
import { selectExplain } from "../engine/dispatchExplain.js";
import { heapReport, heapStart, heapStop, profileCpu, runtimeStatus } from "./profiler.js";
import type { OpsTool } from "./types.js";
import { buildMetrics, bucketMinutesFor } from "../engine/metrics.js";
import { contractsOverview } from "../http/contractsOverview.js";

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
    description: "Filtered ledger rows, newest first (type: PURCHASE|SELL|REFUEL|JUMP|SHIP|CONTRACT|OTHER). Prices are credits; `realized_pnl` is set only on sells with a tracked cost basis. `wallet_after` is the wallet balance right after the trade (rows from 2026-10-08 20:04 UTC onward).",
    input: { ship: z.string().optional(), good: z.string().optional(), type: z.string().optional(), waypoint: z.string().optional(), sinceHours: num(6), limit: num(40) },
    async run(ctx, a) {
      const rows = await ctx.w.store.opsLedger(ctx.w.tenantId, { ship: a.ship, good: a.good, type: a.type, waypoint: a.waypoint, sinceIso: iso(ctx.now() - a.sinceHours * 3_600_000), limit: Math.min(a.limit, 300) });
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
      "For every market with a keeper pinned or on the priority list: covered (a keeper is physically there), enroute (pinned but still flying or waiting at its shipyard), or pending (listed, nobody assigned); lists duplicates (more than one keeper on a market — wasted probes) and uncovered priority markets. Optionally restrict to one system.",
    input: { system: z.string().optional() },
    async run(ctx, a) {
      const { w } = ctx;
      const inSystem = (m: string) => !a.system || m.startsWith(`${a.system}-`);
      const stations = (w.fleet.keeperStations() as { shipSymbol: string; market: string }[]).filter((s) => inSystem(s.market));
      const priority = (await w.fleet.keeperPriorityMarkets()).filter(inSystem);
      const rep = keeperReport(stations, stateShips(ctx), priority);
      const counts = { covered: 0, enroute: 0, pending: 0 };
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
