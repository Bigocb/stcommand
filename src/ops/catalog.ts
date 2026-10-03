import * as z from "zod";
import { logBuffer } from "../core/logBuffer.js";
import { INSTANCE_ID, rateLimitMonitor } from "../core/rateLimitMonitor.js";
import { classifyShips, hopsWithin, keeperReport, type StateShip, type SummaryShip } from "./classify.js";
import type { OpsTool } from "./types.js";

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
    description: "Filtered ledger rows, newest first (type: PURCHASE|SELL|REFUEL|JUMP|SHIP|CONTRACT|OTHER). Prices are credits; `realized_pnl` is set only on sells with a tracked cost basis.",
    input: { ship: z.string().optional(), good: z.string().optional(), type: z.string().optional(), waypoint: z.string().optional(), sinceHours: num(6), limit: num(40) },
    async run(ctx, a) {
      const rows = await ctx.w.store.opsLedger(ctx.w.tenantId, { ship: a.ship, good: a.good, type: a.type, waypoint: a.waypoint, sinceIso: iso(ctx.now() - a.sinceHours * 3_600_000), limit: Math.min(a.limit, 300) });
      return { returned: rows.length, rows };
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
];

export const OPS_BY_NAME = new Map(OPS_TOOLS.map((t) => [t.name, t]));
