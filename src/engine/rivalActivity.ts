/**
 * Rival activity: what other agents trade at the markets we watch, grouped by agent.
 *
 * Pure. The market log (market_transactions) lists every fill the game reports at a market we scanned, with the ship that
 * made it and the units. An agent is the ship symbol without its last "-suffix" ("TIPTAP-AD" is TIPTAP, "CHAMLIS-DEV-1F"
 * is CHAMLIS-DEV): the log has no agent field. A visit is the run of fills by one ship at one market within a short gap,
 * so a 225-unit load that the market splits into three fills counts as one 225-unit visit. Counts are a floor: a scan
 * only shows the recent fills, and a busy market can roll past some between our reads.
 */

export interface RivalFill { timestamp: string; waypoint: string; good: string; shipSymbol: string; type: string; units: number; pricePerUnit: number }

export interface RivalPolicy {
  /** Fills by one ship at one market with no more than this gap between them are one visit. */
  visitGapMs: number;
}
export const DEFAULT_RIVAL_POLICY: RivalPolicy = { visitGapMs: 3 * 60_000 };

export interface RivalAgent {
  agent: string;
  ships: number;
  visits: number;
  fills: number;
  units: number;
  boughtUnits: number;
  soldUnits: number;
  /** Units per visit: the typical load, and the largest seen (about the biggest hold). */
  medianVisitUnits: number;
  maxVisitUnits: number;
  markets: number;
  topGoods: { good: string; units: number }[];
  topMarkets: { waypoint: string; units: number }[];
}

export const agentOf = (shipSymbol: string): string => {
  const i = shipSymbol.lastIndexOf("-");
  return i > 0 ? shipSymbol.slice(0, i) : shipSymbol;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)) : 0;
};

const top = <T extends string>(m: Map<T, number>, n: number): { key: T; units: number }[] =>
  [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n).map(([key, units]) => ({ key, units }));

export interface RivalReport {
  fills: number;
  agents: RivalAgent[];
}

/**
 * @param fills        fills by ships that are not ours (the caller leaves ours out)
 * @param agentFilter  keep only agents whose name contains this (case-insensitive); empty keeps all
 * @param minUnits     drop agents with fewer total units
 */
export function rivalActivity(fills: readonly RivalFill[], opts: { agentFilter?: string; minUnits?: number; limit?: number } = {}, policy: RivalPolicy = DEFAULT_RIVAL_POLICY): RivalReport {
  const sorted = [...fills].filter((f) => f.good !== "FUEL").sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const byAgent = new Map<string, RivalFill[]>();
  for (const f of sorted) {
    const a = agentOf(f.shipSymbol);
    (byAgent.get(a) ?? byAgent.set(a, []).get(a)!).push(f);
  }
  const filter = (opts.agentFilter ?? "").trim().toLowerCase();
  const agents: RivalAgent[] = [];
  for (const [agent, list] of byAgent) {
    if (filter && !agent.toLowerCase().includes(filter)) continue;
    const units = list.reduce((s, f) => s + f.units, 0);
    if (units < (opts.minUnits ?? 0)) continue;
    // Visits: per ship and market, fills joined while the gap stays small.
    const last = new Map<string, { at: number; units: number }>();
    const visits: number[] = [];
    for (const f of list) {
      const key = `${f.shipSymbol}|${f.waypoint}`;
      const at = Date.parse(f.timestamp);
      const cur = last.get(key);
      if (cur && at - cur.at <= policy.visitGapMs) { cur.at = at; cur.units += f.units; }
      else { if (cur) visits.push(cur.units); last.set(key, { at, units: f.units }); }
    }
    for (const cur of last.values()) visits.push(cur.units);
    const goods = new Map<string, number>();
    const markets = new Map<string, number>();
    let bought = 0;
    let sold = 0;
    for (const f of list) {
      goods.set(f.good, (goods.get(f.good) ?? 0) + f.units);
      markets.set(f.waypoint, (markets.get(f.waypoint) ?? 0) + f.units);
      if (f.type === "PURCHASE") bought += f.units; else sold += f.units;
    }
    agents.push({
      agent, ships: new Set(list.map((f) => f.shipSymbol)).size, visits: visits.length, fills: list.length, units,
      boughtUnits: bought, soldUnits: sold, medianVisitUnits: median(visits), maxVisitUnits: Math.max(...visits),
      markets: markets.size,
      topGoods: top(goods, 4).map((x) => ({ good: x.key, units: x.units })),
      topMarkets: top(markets, 3).map((x) => ({ waypoint: x.key, units: x.units })),
    });
  }
  agents.sort((a, b) => b.units - a.units || a.agent.localeCompare(b.agent));
  return { fills: sorted.length, agents: agents.slice(0, opts.limit ?? 25) };
}
