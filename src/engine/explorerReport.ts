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
}): ExplorerReport {
  const limit = i.listLimit ?? 60;
  const surveyBySystem = new Map(i.surveys.map((s) => [s.system, s]));
  const stationOf = new Map(i.stations.map((k) => [k.ship, k.market]));

  // Keepers: a ship purchase counts when that ship is now stationed as a keeper. Bought-for market is where it stands.
  const keepers = i.purchases
    .filter((p) => stationOf.has(p.ship))
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
    systems: systems.slice(0, limit),
    keepers: keepers.slice(0, limit),
  };
}
