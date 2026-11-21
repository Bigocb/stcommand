/**
 * Value-tiered keeper read frequency (issue #68, parent #65).
 *
 * Every keeper market used to be read on one rotation, so a quiet market cost as much reading as one at the end of a live
 * 600k route (2026-11-21: about 1,700 keepers, a pass took 30-60 minutes). This sorts each keeper market into a tier and
 * gives it a read interval:
 *
 * - HOT: the buy or sell end of a route a trader is assigned to, or of one of the board's top N routes (default every 10 min).
 * - WARM: a leg on the board worth at least `warmMinProfit` touches it, or we traded there within `recentTradeMs` (30 min).
 * - COLD: nothing worth trading there recently (100 min, capped below Intel freshness so its prices never age out of the
 *   route list, which would keep it COLD for good).
 *
 * Pure: no I/O, no clock, no globals. The caller passes the time, the board, the assignments and when each market was last
 * traded and read. The intervals map (`keeperReadIntervals`) is the shape the rate-based keeper read scheduler accepts.
 */

export type KeeperReadTier = "HOT" | "WARM" | "COLD";

export const KEEPER_READ_TIERS: readonly KeeperReadTier[] = ["HOT", "WARM", "COLD"];

export interface KeeperReadTierPolicy {
  hotMs: number;
  warmMs: number;
  coldMs: number;
  /** Markets on the board's N most profitable routes are HOT. 0 = only assigned routes make a market HOT. */
  topN: number;
  /** A board leg touching the market must make at least this many credits a trip to make it WARM. */
  warmMinProfit: number;
  /** A trade of ours at the market (either side) within this window makes it WARM. */
  recentTradeMs: number;
  /** No interval is longer than this (the caller passes Intel freshness less a margin). Absent = no cap. */
  ceilingMs?: number;
}

export const DEFAULT_KEEPER_READ_TIER_POLICY: KeeperReadTierPolicy = {
  hotMs: 10 * 60_000,
  warmMs: 30 * 60_000,
  coldMs: 100 * 60_000,
  topN: 10,
  warmMinProfit: 10_000,
  recentTradeMs: 3 * 3_600_000,
};

/** What the fleet knows about one keeper market. */
export interface KeeperMarketFacts {
  waypoint: string;
  /** A route a trader is assigned to (auto or manual) buys or sells here. */
  assignedRoute: boolean;
  /** Best rank (0 = most profitable) of a board route touching this market. Absent = no board route touches it. */
  boardRank?: number;
  /** Best profit per trip of a board route touching this market. */
  bestLegProfit?: number;
  /** When we last bought or sold here (ms epoch). */
  lastTradeAt?: number;
  /** When the market was last read (ms epoch). Absent = never read. */
  lastReadAt?: number;
}

export interface KeeperReadTierDecision {
  waypoint: string;
  tier: KeeperReadTier;
  intervalMs: number;
  /** How long until the next read is due (0 = due now, including a market never read). */
  dueInMs: number;
  reason: string;
}

const min = (ms: number) => `${Math.round(ms / 60_000)}m`;

function intervalFor(tier: KeeperReadTier, p: KeeperReadTierPolicy): { ms: number; capped: boolean } {
  const raw = tier === "HOT" ? p.hotMs : tier === "WARM" ? p.warmMs : p.coldMs;
  const ms = Math.max(60_000, raw);
  if (p.ceilingMs !== undefined && p.ceilingMs > 0 && ms > p.ceilingMs) return { ms: Math.max(60_000, p.ceilingMs), capped: true };
  return { ms, capped: false };
}

/** The tier, read interval and one-line reason for one market. */
export function classifyKeeperMarket(f: KeeperMarketFacts, policy: KeeperReadTierPolicy, nowMs: number): KeeperReadTierDecision {
  let tier: KeeperReadTier;
  let why: string;
  if (f.assignedRoute) {
    tier = "HOT"; why = "an assigned trader route buys or sells here";
  } else if (policy.topN > 0 && f.boardRank !== undefined && f.boardRank < policy.topN) {
    tier = "HOT"; why = `on board route #${f.boardRank + 1} (top ${policy.topN})`;
  } else if (f.bestLegProfit !== undefined && f.bestLegProfit > 0 && f.bestLegProfit >= policy.warmMinProfit) {
    tier = "WARM"; why = `board leg worth ${Math.round(f.bestLegProfit)}c/trip (>= ${policy.warmMinProfit})`;
  } else if (f.lastTradeAt !== undefined && nowMs - f.lastTradeAt <= policy.recentTradeMs) {
    tier = "WARM"; why = `we traded here ${min(nowMs - f.lastTradeAt)} ago (within ${min(policy.recentTradeMs)})`;
  } else {
    tier = "COLD";
    why = f.bestLegProfit !== undefined ? `best board leg ${Math.round(f.bestLegProfit)}c/trip, under ${policy.warmMinProfit}, no recent trade` : "no board route and no recent trade";
  }
  const { ms, capped } = intervalFor(tier, policy);
  const age = f.lastReadAt === undefined ? undefined : Math.max(0, nowMs - f.lastReadAt);
  const dueInMs = age === undefined ? 0 : Math.max(0, ms - age);
  const read = age === undefined ? "never read" : `read ${min(age)} ago`;
  return { waypoint: f.waypoint, tier, intervalMs: ms, dueInMs, reason: `${tier} every ${min(ms)}${capped ? " (capped at Intel freshness)" : ""}: ${why}; ${read}` };
}

export function classifyKeeperMarkets(markets: readonly KeeperMarketFacts[], policy: KeeperReadTierPolicy, nowMs: number): KeeperReadTierDecision[] {
  return markets.map((m) => classifyKeeperMarket(m, policy, nowMs));
}

/** waypoint -> read interval in ms, the shape the rate-based keeper read scheduler accepts. */
export function keeperReadIntervals(decisions: readonly KeeperReadTierDecision[]): Map<string, number> {
  return new Map(decisions.map((d) => [d.waypoint, d.intervalMs]));
}

/** Per market, what the board and the assignments say about it: the inputs to `classifyKeeperMarket` that come from routes. */
export interface BoardFacts {
  assignedRoute: boolean;
  boardRank?: number;
  bestLegProfit?: number;
}

/**
 * Index the board and the trader assignments by market. Routes are ranked by profit per trip (highest first), whatever order
 * the caller passes them in; a route touches its buy and its sell market.
 */
export function boardFactsByMarket(
  routes: readonly { buyAt: string; sellAt: string; profitPerTrip: number }[],
  assigned: readonly { buyAt?: string; sellAt?: string }[],
): Map<string, BoardFacts> {
  const out = new Map<string, BoardFacts>();
  const at = (m: string): BoardFacts => {
    let f = out.get(m);
    if (!f) { f = { assignedRoute: false }; out.set(m, f); }
    return f;
  };
  const ranked = routes.map((r, i) => ({ r, i })).sort((a, b) => b.r.profitPerTrip - a.r.profitPerTrip || a.i - b.i);
  ranked.forEach(({ r }, rank) => {
    for (const m of r.buyAt === r.sellAt ? [r.buyAt] : [r.buyAt, r.sellAt]) {
      const f = at(m);
      if (f.boardRank === undefined || rank < f.boardRank) f.boardRank = rank;
      if (f.bestLegProfit === undefined || r.profitPerTrip > f.bestLegProfit) f.bestLegProfit = r.profitPerTrip;
    }
  });
  for (const a of assigned) {
    if (a.buyAt) at(a.buyAt).assignedRoute = true;
    if (a.sellAt) at(a.sellAt).assignedRoute = true;
  }
  return out;
}

export interface TierSummaryRow {
  tier: KeeperReadTier;
  markets: number;
  intervalMin: number;
  /** Reads a minute this tier asks for (markets / interval). */
  demandReadsPerMin: number;
  /** How long a pass over this tier really takes at the measured read rate: the interval, stretched when keepers ask for more reads than they get. */
  effectivePassMin: number;
  /** Ages of the current reads: median and oldest, in minutes. Null when no market of the tier has been read. */
  readAgeMedianMin: number | null;
  readAgeMaxMin: number | null;
  dueNow: number;
}

/**
 * Counts per tier and the effective pass time per tier. When the keepers' measured read rate is below what the tiers ask for,
 * every interval stretches by the same factor (the scheduler serves keepers as they come due), so the effective pass is the
 * interval times demand / measured. Without a measured rate the effective pass is the interval.
 */
export function summarizeKeeperReadTiers(
  decisions: readonly KeeperReadTierDecision[],
  facts: ReadonlyMap<string, { lastReadAt?: number }>,
  nowMs: number,
  measuredReadsPerMin?: number,
): { tiers: TierSummaryRow[]; demandReadsPerMin: number; measuredReadsPerMin: number | null; stretch: number } {
  const groups = new Map<KeeperReadTier, KeeperReadTierDecision[]>(KEEPER_READ_TIERS.map((t) => [t, []]));
  for (const d of decisions) groups.get(d.tier)!.push(d);
  const demand = decisions.reduce((s, d) => s + 60_000 / d.intervalMs, 0);
  const stretch = measuredReadsPerMin !== undefined && measuredReadsPerMin > 0 && demand > measuredReadsPerMin ? demand / measuredReadsPerMin : 1;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const tiers = KEEPER_READ_TIERS.map((tier): TierSummaryRow => {
    const list = groups.get(tier)!;
    const intervals = list.map((d) => d.intervalMs);
    const intervalMs = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
    const ages = list.map((d) => facts.get(d.waypoint)?.lastReadAt).filter((t): t is number => t !== undefined).map((t) => Math.max(0, nowMs - t) / 60_000).sort((a, b) => a - b);
    return {
      tier,
      markets: list.length,
      intervalMin: r1(intervalMs / 60_000),
      demandReadsPerMin: r1(list.reduce((s, d) => s + 60_000 / d.intervalMs, 0)),
      effectivePassMin: r1((intervalMs / 60_000) * stretch),
      readAgeMedianMin: ages.length ? r1(ages[Math.floor((ages.length - 1) / 2)]!) : null,
      readAgeMaxMin: ages.length ? r1(ages[ages.length - 1]!) : null,
      dueNow: list.filter((d) => d.dueInMs === 0).length,
    };
  });
  return { tiers, demandReadsPerMin: r1(demand), measuredReadsPerMin: measuredReadsPerMin === undefined ? null : r1(measuredReadsPerMin), stretch: Math.round(stretch * 100) / 100 };
}
