/**
 * Pure investigation logic for the ops layer — no I/O, so it is unit tested
 * (tests/opsClassify.test.ts) and the catalog tools stay thin.
 */

export interface SummaryShip {
  symbol: string;
  role: string;
  waypoint: string;
  nav: string;
  fuel: number;
  fuelCap: number;
  cargo?: number;
  cargoCap?: number;
  doing?: string;
}

/** The polled raw ship (GET /state → ships[]), fresher than an agent's cache. */
export interface StateShip {
  symbol: string;
  nav?: { status?: string; waypointSymbol?: string; route?: { arrival?: string } };
  fuel?: { current?: number; capacity?: number };
}

export type Severity = "crit" | "warn" | "info";

export interface Finding {
  ship: string;
  severity: Severity;
  kind: "stranded" | "out_of_fuel" | "low_fuel" | "transit_overdue" | "agent_behind" | "suspended";
  detail: string;
}

const RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };

/**
 * What looks wrong right now. `stranded` comes from the fleet's own detector;
 * everything else is derived by comparing the agent's cached summary with the
 * polled game state. Keepers (zero-tank probes) are exempt from fuel checks.
 */
export function classifyShips(summary: SummaryShip[], stateShips: StateShip[], stranded: Set<string>, now: number): Finding[] {
  const live = new Map(stateShips.map((s) => [s.symbol, s]));
  const out: Finding[] = [];
  for (const s of summary) {
    const st = live.get(s.symbol);
    if (stranded.has(s.symbol)) {
      out.push({ ship: s.symbol, severity: "crit", kind: "stranded", detail: `${s.role} stranded at ${s.waypoint}, fuel ${s.fuel}/${s.fuelCap}` });
    }
    const fuel = st?.fuel?.current ?? s.fuel;
    const cap = st?.fuel?.capacity ?? s.fuelCap;
    if (cap > 0 && !stranded.has(s.symbol)) {
      const status = st?.nav?.status ?? s.nav;
      if (fuel === 0) {
        out.push({ ship: s.symbol, severity: status === "DOCKED" ? "warn" : "crit", kind: "out_of_fuel", detail: `fuel 0/${cap}, ${status.toLowerCase()} at ${st?.nav?.waypointSymbol ?? s.waypoint}` });
      } else if (fuel / cap < 0.1 && s.role !== "keeper") {
        // Keepers sit docked at a market for good; a low tank on a hull that
        // never flies is noise (live: 11 of 12 warnings were parked keepers).
        out.push({ ship: s.symbol, severity: "warn", kind: "low_fuel", detail: `fuel ${fuel}/${cap} (${Math.round((fuel / cap) * 100)}%)` });
      }
    }
    if (st?.nav?.status === "IN_TRANSIT" && st.nav.route?.arrival) {
      const overdue = now - new Date(st.nav.route.arrival).getTime();
      if (overdue > 90_000) {
        out.push({ ship: s.symbol, severity: "warn", kind: "transit_overdue", detail: `polled state says in transit but arrival passed ${Math.round(overdue / 1000)}s ago` });
      }
    }
    if (st?.nav?.status && st.nav.status !== s.nav && s.nav !== "IDLE") {
      out.push({
        ship: s.symbol, severity: "info", kind: "agent_behind",
        detail: `agent snapshot says ${s.nav} at ${s.waypoint}; polled state says ${st.nav.status} at ${st.nav.waypointSymbol} — normal for up to one task cycle, persistent means the ship's task isn't running`,
      });
    }
    if (s.doing === "suspended") {
      out.push({ ship: s.symbol, severity: "info", kind: "suspended", detail: `agent suspended (${s.role})` });
    }
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.ship.localeCompare(b.ship));
}

export interface KeeperStation {
  shipSymbol: string;
  market: string;
}

export type Coverage = "covered" | "enroute" | "pending" | "none";

export interface KeeperMarketRow {
  market: string;
  status: Coverage;
  ships: { ship: string; at?: string; nav?: string; arrival?: string }[];
  duplicate: boolean;
}

/**
 * Per-market keeper coverage. A pinned keeper only counts as covering once it
 * is physically at the market and not mid-flight (a probe waits for its first
 * task tick, then drifts); a pin on a ship missing from state counts as
 * arrived. Mirrors `keeperCoverage()` in public/shared/domain.js.
 */
export function keeperReport(stations: KeeperStation[], stateShips: StateShip[], priority: string[]): { markets: KeeperMarketRow[]; duplicates: string[]; uncoveredPriority: string[] } {
  const live = new Map(stateShips.map((s) => [s.symbol, s]));
  const byMarket = new Map<string, KeeperStation[]>();
  for (const st of stations) byMarket.set(st.market, [...(byMarket.get(st.market) ?? []), st]);
  const markets: KeeperMarketRow[] = [];
  for (const [market, pins] of byMarket) {
    const ships = pins.map((p) => {
      const s = live.get(p.shipSymbol);
      return { ship: p.shipSymbol, at: s?.nav?.waypointSymbol, nav: s?.nav?.status, arrival: s?.nav?.status === "IN_TRANSIT" ? s.nav.route?.arrival : undefined };
    });
    const anyArrived = pins.some((p) => {
      const s = live.get(p.shipSymbol);
      return !s || (s.nav?.status !== "IN_TRANSIT" && s.nav?.waypointSymbol === market);
    });
    markets.push({ market, status: anyArrived ? "covered" : "enroute", ships, duplicate: pins.length > 1 });
  }
  const uncoveredPriority = priority.filter((m) => !byMarket.has(m));
  for (const m of uncoveredPriority) markets.push({ market: m, status: "pending", ships: [], duplicate: false });
  markets.sort((a, b) => a.market.localeCompare(b.market));
  return { markets, duplicates: markets.filter((m) => m.duplicate).map((m) => m.market), uncoveredPriority };
}

/** BFS over a gate adjacency map; returns system → hop count within `maxHops`. */
export function hopsWithin(adj: Map<string, string[]>, from: string, maxHops: number): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    if (d >= maxHops) continue;
    for (const n of adj.get(cur) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}
