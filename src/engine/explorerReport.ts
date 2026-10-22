/**
 * The Explorers tab: what each explorer is doing, which systems have been looked at and how they came out, and which keepers
 * were bought and stationed. Pure: the ops tool (src/ops/explorers.ts) fetches the rows and hands them in, so the shape of the
 * report is testable without a database or a fleet.
 *
 * Verdicts come from the survey mark's source, not from re-judging: `rejected` is the explorer's worth threshold saying no
 * (systemWorth.ts), `atlas` is a mark seeded from the galaxy atlas rather than a visit, anything else is a real survey.
 */

const systemOf = (waypoint: string) => waypoint.slice(0, waypoint.lastIndexOf("-"));

export interface ExplorerShipRow {
  symbol: string; waypoint: string; nav: string; fuel: number; fuelCap: number; cooldown: number; doing: string;
  /** An interrupted tour still to finish: the system and how many stops are left. */
  tour?: { system: string; stopsLeft: number };
}
export interface JumpRow { at: string; ship: string; from: string; to: string; cost: number }
export interface SurveyRow { system: string; at: string; markets: number; shipyards: number; source: string }
export interface KeeperStation { ship: string; market: string }
export interface ShipPurchaseRow { at: string; ship: string; yard: string; hull: string; price: number }

/** First and last trade (PURCHASE or SELL) the ledger holds for one system this week. */
export interface SystemTradeSpan { system: string; firstAt: string; lastAt: string }

export type SystemVerdict = "rejected" | "surveyed" | "atlas";

export interface ExplorerReport {
  asOf: string;
  windowHours: number;
  totals: { explorers: number; systemsSurveyed: number; systemsRejected: number; keepersBought: number; keeperSpend: number; jumps: number; jumpSpend: number };
  explorers: {
    ship: string; system: string; waypoint: string; nav: string; fuelPct: number; doing: string;
    tour?: { system: string; stopsLeft: number };
    jumps: number; jumpSpend: number;
    /** Newest first, consecutive repeats collapsed; the verdict is the survey mark's, if the system has one. */
    visited: { system: string; at: string; verdict?: SystemVerdict }[];
  }[];
  /** How many systems we trade in and keep keepers in, now and over the week. */
  coverage: Coverage;
  systems: { system: string; at: string; markets: number; shipyards: number; verdict: SystemVerdict; keepersStationed: number; keepersBought: number }[];
  keepers: { ship: string; market: string; system: string; yard: string; hull: string; price: number; at: string }[];
}

export function verdictOf(source: string): SystemVerdict {
  return source === "rejected" ? "rejected" : source === "backfill" ? "atlas" : "surveyed";
}

export function buildExplorerReport(i: {
  nowIso: string; windowHours: number;
  explorers: ExplorerShipRow[]; jumps: JumpRow[]; surveys: SurveyRow[]; stations: KeeperStation[]; purchases: ShipPurchaseRow[];
  /** Newest systems and keepers to list; the totals always cover everything passed in. */
  listLimit?: number;
  /** Per-system first and last trade for the coverage figures; omitted = no coverage data. */
  trades?: SystemTradeSpan[];
}): ExplorerReport {
  const limit = i.listLimit ?? 60;
  const surveyBySystem = new Map(i.surveys.map((s) => [s.system, s]));
  const stationOf = new Map(i.stations.map((k) => [k.ship, k.market]));

  // Keepers: a ship purchase counts when that ship is now stationed as a keeper. Bought-for market is where it stands.
  // `purchases` may reach back further than the window (the coverage history needs the whole week); the list and totals are the window's.
  const sinceMs = Date.parse(i.nowIso) - i.windowHours * 3_600_000;
  const keepers = i.purchases
    .filter((p) => stationOf.has(p.ship) && Date.parse(p.at) >= sinceMs)
    .map((p) => { const market = stationOf.get(p.ship)!; return { ship: p.ship, market, system: systemOf(market), yard: p.yard, hull: p.hull, price: p.price, at: p.at }; })
    .sort((a, b) => b.at.localeCompare(a.at));
  const boughtIn = new Map<string, number>();
  for (const k of keepers) boughtIn.set(k.system, (boughtIn.get(k.system) ?? 0) + 1);
  const stationedIn = new Map<string, number>();
  for (const k of i.stations) stationedIn.set(systemOf(k.market), (stationedIn.get(systemOf(k.market)) ?? 0) + 1);

  const systems = [...i.surveys]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((s) => ({
      system: s.system, at: s.at, markets: s.markets, shipyards: s.shipyards, verdict: verdictOf(s.source),
      keepersStationed: stationedIn.get(s.system) ?? 0, keepersBought: boughtIn.get(s.system) ?? 0,
    }));

  const explorers = i.explorers.map((e) => {
    const mine = i.jumps.filter((j) => j.ship === e.symbol).sort((a, b) => b.at.localeCompare(a.at));
    const visited: ExplorerReport["explorers"][number]["visited"] = [];
    for (const j of mine) {
      const system = systemOf(j.to);
      if (visited[visited.length - 1]?.system === system) continue;
      const mark = surveyBySystem.get(system);
      visited.push({ system, at: j.at, ...(mark ? { verdict: verdictOf(mark.source) } : {}) });
    }
    return {
      ship: e.symbol, system: systemOf(e.waypoint), waypoint: e.waypoint, nav: e.nav,
      fuelPct: e.fuelCap > 0 ? Math.round((e.fuel / e.fuelCap) * 100) : 0,
      doing: e.doing, ...(e.tour ? { tour: e.tour } : {}),
      jumps: mine.length, jumpSpend: mine.reduce((t, j) => t + j.cost, 0),
      visited: visited.slice(0, 12),
    };
  });

  const explorerShips = new Set(i.explorers.map((e) => e.symbol));
  const theirJumps = i.jumps.filter((j) => explorerShips.has(j.ship));
  return {
    asOf: i.nowIso,
    windowHours: i.windowHours,
    totals: {
      explorers: i.explorers.length,
      systemsSurveyed: systems.filter((s) => s.verdict === "surveyed").length,
      systemsRejected: systems.filter((s) => s.verdict === "rejected").length,
      keepersBought: keepers.length,
      keeperSpend: keepers.reduce((t, k) => t + k.price, 0),
      jumps: theirJumps.length,
      jumpSpend: theirJumps.reduce((t, j) => t + j.cost, 0),
    },
    explorers,
    coverage: buildCoverage({
      nowMs: Date.parse(i.nowIso),
      trades: i.trades ?? [],
      keeperSystems: i.stations.map((k) => ({
        system: systemOf(k.market),
        at: i.purchases.find((p) => p.ship === k.ship)?.at,
      })),
    }),
    systems: systems.slice(0, limit),
    keepers: keepers.slice(0, limit),
  };
}

export interface CoveragePoint { at: string; trading: number; keepers: number }
export interface Coverage {
  /** Systems with at least one trade this week. */
  trading: number;
  /** Of those, systems traded in within the last 24 hours. */
  tradingLast24h: number;
  /** Systems where a keeper is stationed now. */
  keepers: number;
  /** Cumulative systems traded in / with a keeper, oldest first, at most 48 points ending now. */
  series: CoveragePoint[];
}

const HOUR = 3_600_000;

/**
 * Systems we trade in and have keepers in, now and as they grew.
 *
 * Trading: a system counts from its first trade in the ledger. Keepers: a system counts from the purchase of the earliest
 * keeper now stationed there; a keeper with no purchase row this week (it predates it) counts from the start of the series, so
 * the last point always equals the current count. A keeper since scrapped is not counted, as the ledger does not say where it stood.
 */
export function buildCoverage(i: {
  nowMs: number;
  trades: readonly SystemTradeSpan[];
  /** When each stationed keeper was bought, by the system it stands in (earliest wins); keepers with no purchase row are passed with `at` undefined. */
  keeperSystems: readonly { system: string; at?: string }[];
  maxPoints?: number;
}): Coverage {
  const maxPoints = i.maxPoints ?? 48;
  const tradeStart = new Map<string, number>();
  for (const t of i.trades) tradeStart.set(t.system, Math.min(tradeStart.get(t.system) ?? Infinity, Date.parse(t.firstAt)));
  const keeperStart = new Map<string, number | undefined>();
  for (const k of i.keeperSystems) {
    const at = k.at === undefined ? undefined : Date.parse(k.at);
    const had = keeperStart.get(k.system);
    if (!keeperStart.has(k.system)) keeperStart.set(k.system, at);
    else if (at !== undefined && (had === undefined || at < had)) keeperStart.set(k.system, at);
  }
  const known = [...tradeStart.values(), ...[...keeperStart.values()].filter((v): v is number => v !== undefined)];
  const t0 = known.length ? Math.min(...known) : i.nowMs;
  const span = Math.max(i.nowMs - t0, HOUR);
  const bucket = Math.max(HOUR, Math.ceil(span / maxPoints / HOUR) * HOUR);

  const countAt = (starts: Iterable<number | undefined>, at: number) => { let n = 0; for (const s of starts) if ((s ?? t0) <= at) n++; return n; };
  const series: CoveragePoint[] = [];
  for (let at = t0 + bucket; at < i.nowMs; at += bucket) {
    series.push({ at: new Date(at).toISOString(), trading: countAt(tradeStart.values(), at), keepers: countAt(keeperStart.values(), at) });
  }
  series.push({ at: new Date(i.nowMs).toISOString(), trading: tradeStart.size, keepers: keeperStart.size });

  const cutoff = i.nowMs - 24 * HOUR;
  return {
    trading: tradeStart.size,
    tradingLast24h: i.trades.filter((t) => Date.parse(t.lastAt) >= cutoff).length,
    keepers: keeperStart.size,
    series,
  };
}
