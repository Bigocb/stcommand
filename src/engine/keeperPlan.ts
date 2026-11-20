/**
 * Which markets deserve a fixed keeper, and which can be left to a touring keeper (operator design, 2026-11-20, issue #63).
 *
 * Today every worthwhile market of a live system ends up with its own keeper. About 40% of them sit on markets no route of ours
 * ever uses (137 of 335 saw none of our trades on 2026-11-20), and covering the 297 still uncovered markets would cost 10-12M. The
 * plan keeps fixed keepers on the markets that earn: shipyards (a docked ship is what reads a yard and lets us buy there), the buy
 * and sell ends of good routes, and the market types that traded best this week (13 or more goods, and 7 goods). Everything else is
 * left to a touring keeper. A market covered only by the tour that starts showing up at either end of a good route is promoted to a
 * fixed keeper; a fixed keeper whose market has been off every good route for a while is demoted, and its hull can be moved to a
 * promoted market in the same system instead of buying a new one.
 *
 * Pure: no I/O, no clock, no globals. Everything comes in through `KeeperPlanInput`; the policy is data backed by doctrine clauses.
 * The caller decides what to act on. Every decision carries a one-line reason.
 */

export interface KeeperPlanPolicy {
  /** A market with at least this many goods always earns a fixed keeper. 0 = no such rule. */
  fixedMinGoods: number;
  /** Goods counts that also earn a fixed keeper (7 on 2026-11-20: the A1/D4x markets). */
  fixedExactGoods: readonly number[];
  /** A route paying at least this per trip counts as a good route for promotion and demotion. */
  routeMinProfit: number;
  /** A fixed keeper whose market has been off every good route this long is demoted. */
  demoteAfterMs: number;
  /** Promotions handed out per pass at most. */
  maxPromotionsPerPass: number;
  /** Hull moves (demoted keeper to a promoted market in the same system) per pass at most. */
  maxMovesPerPass: number;
}

export const DEFAULT_KEEPER_PLAN_POLICY: KeeperPlanPolicy = {
  fixedMinGoods: 13,
  fixedExactGoods: [7],
  routeMinProfit: 50_000,
  demoteAfterMs: 6 * 3_600_000,
  maxPromotionsPerPass: 2,
  maxMovesPerPass: 1,
};

export interface PlanMarket {
  market: string;
  system: string;
  /** Distinct goods from the market directory; undefined when the directory has no row for it. */
  goods?: number;
  yard: boolean;
  /** The keeper ship stationed on it, if any. */
  keeper?: string;
  /** Already on the keeper priority list (a keeper is being bought for it). */
  listed?: boolean;
}

export interface KeeperPlanInput {
  nowMs: number;
  /** Markets of the live systems the plan covers. */
  markets: readonly PlanMarket[];
  /** When each market was last seen at either end of a good route (persisted by the caller). */
  routeSeenAt: ReadonlyMap<string, number>;
  /** When route tracking started; a market never seen on a route counts as last seen at this time, so a fresh start demotes nobody. */
  trackedSinceMs: number;
}

export type FixedReason = "yard" | "route" | "goods";

export interface KeeperPlan {
  /** Markets with no keeper that the plan wants one on, best reason first. */
  promote: { market: string; system: string; reason: string }[];
  /** Keepers whose market no longer earns a fixed keeper. */
  demote: { ship: string; market: string; system: string; reason: string }[];
  /** A demoted hull moved to a promoted market of the same system (no purchase). */
  moves: { ship: string; from: string; to: string; system: string; reason: string }[];
  /** Per system: markets with a fixed reason, and markets left to the tour. */
  systems: { system: string; fixed: number; tour: number; tourMarkets: string[] }[];
}

/** Why a market earns a fixed keeper, or undefined when the tour is enough. */
export function fixedReason(m: PlanMarket, p: KeeperPlanPolicy, routeSeenAt: ReadonlyMap<string, number>, nowMs: number, trackedSinceMs: number): FixedReason | undefined {
  if (m.yard) return "yard";
  if (m.goods !== undefined && ((p.fixedMinGoods > 0 && m.goods >= p.fixedMinGoods) || p.fixedExactGoods.includes(m.goods))) return "goods";
  const seen = routeSeenAt.get(m.market);
  if (seen !== undefined && nowMs - seen < p.demoteAfterMs) return "route";
  // A market with a keeper that has not been tracked long enough to judge keeps its keeper.
  if (m.keeper && nowMs - Math.max(seen ?? 0, trackedSinceMs) < p.demoteAfterMs) return "route";
  return undefined;
}

function describe(r: FixedReason, m: PlanMarket, routeSeenAt: ReadonlyMap<string, number>, nowMs: number): string {
  if (r === "yard") return "shipyard";
  if (r === "goods") return `${m.goods} goods`;
  const seen = routeSeenAt.get(m.market);
  return seen === undefined ? "not judged yet" : `on a good route ${Math.round((nowMs - seen) / 60_000)} min ago`;
}

const RANK: Record<FixedReason, number> = { yard: 0, route: 1, goods: 2 };

export function planKeepers(input: KeeperPlanInput, p: KeeperPlanPolicy = DEFAULT_KEEPER_PLAN_POLICY): KeeperPlan {
  const { nowMs, routeSeenAt, trackedSinceMs } = input;
  const promoteAll: { market: string; system: string; reason: string; rank: number }[] = [];
  const demote: KeeperPlan["demote"] = [];
  const bySystem = new Map<string, { fixed: number; tourMarkets: string[] }>();
  for (const m of input.markets) {
    const s = bySystem.get(m.system) ?? { fixed: 0, tourMarkets: [] };
    bySystem.set(m.system, s);
    const r = fixedReason(m, p, routeSeenAt, nowMs, trackedSinceMs);
    if (r) s.fixed += 1; else s.tourMarkets.push(m.market);
    if (r && !m.keeper && !m.listed && r === "route") {
      // Only route ends are promoted here: yards and goods-rule markets are already bought by the usual keeper queue and top-up.
      promoteAll.push({ market: m.market, system: m.system, reason: describe(r, m, routeSeenAt, nowMs), rank: RANK[r] });
    }
    if (!r && m.keeper) {
      const seen = routeSeenAt.get(m.market);
      const idleH = Math.round(((nowMs - Math.max(seen ?? 0, trackedSinceMs)) / 3_600_000) * 10) / 10;
      demote.push({ ship: m.keeper, market: m.market, system: m.system, reason: `${m.goods ?? "?"} goods, off every good route for ${idleH} h` });
    }
  }
  promoteAll.sort((a, b) => a.rank - b.rank || a.market.localeCompare(b.market));
  // A promoted market in a system with a demoted hull takes that hull instead of a purchase.
  const moves: KeeperPlan["moves"] = [];
  const usedShips = new Set<string>();
  const movedTo = new Set<string>();
  for (const target of promoteAll) {
    if (moves.length >= p.maxMovesPerPass) break;
    const hull = demote.find((d) => d.system === target.system && !usedShips.has(d.ship));
    if (!hull) continue;
    usedShips.add(hull.ship);
    movedTo.add(target.market);
    moves.push({ ship: hull.ship, from: hull.market, to: target.market, system: target.system, reason: `${target.market} ${target.reason}; ${hull.market} ${hull.reason}` });
  }
  const promote = promoteAll.filter((x) => !movedTo.has(x.market)).slice(0, p.maxPromotionsPerPass).map(({ market, system, reason }) => ({ market, system, reason }));
  const systems = [...bySystem].map(([system, s]) => ({ system, fixed: s.fixed, tour: s.tourMarkets.length, tourMarkets: s.tourMarkets }))
    .sort((a, b) => b.tour - a.tour || a.system.localeCompare(b.system));
  return { promote, demote, moves, systems };
}

/**
 * Record the markets at either end of every good route as seen now. Returns a new map (the input is not changed) and whether
 * anything changed, so the caller saves it only when it must.
 */
export function noteRouteEnds(
  seen: ReadonlyMap<string, number>,
  routes: readonly { buyAt: string; sellAt: string; profitPerTrip: number }[],
  minProfit: number,
  nowMs: number,
): { seen: Map<string, number>; changed: boolean } {
  const out = new Map(seen);
  let changed = false;
  for (const r of routes) {
    if (!(r.profitPerTrip >= minProfit)) continue;
    for (const m of [r.buyAt, r.sellAt]) {
      if (!m) continue;
      // Refreshed at most once a minute per market, so a save every dispatcher cycle is not forced by tiny moves.
      const before = out.get(m);
      if (before === undefined || nowMs - before >= 60_000) { out.set(m, nowMs); changed = true; }
    }
  }
  // Drop markets not seen for two days: a reset or a dead system should not grow the flag for ever.
  for (const [m, t] of out) if (nowMs - t > 48 * 3_600_000) { out.delete(m); changed = true; }
  return { seen: out, changed };
}

/** Route tracking as saved in the fleet flag `keeperRouteSeen`: when tracking started and each market's last good-route time. */
export interface RouteSeenState { trackedSinceMs: number; seen: Map<string, number>; lastNotedMs?: number }

/**
 * Route ends are only recorded while the plan is on (and the server is up). After a gap in recording, the time not watched must not
 * count as "off every good route", or switching the plan on hours later (or a long outage) would demote every keeper at once. So when
 * the last recording is older than `maxGapMs` (or there was none), judging restarts now. Returns whether it restarted.
 */
export function resumeTracking(s: RouteSeenState, nowMs: number, maxGapMs = 15 * 60_000): boolean {
  const gap = s.lastNotedMs === undefined || nowMs - s.lastNotedMs > maxGapMs;
  if (gap) s.trackedSinceMs = nowMs;
  s.lastNotedMs = nowMs;
  return gap;
}

export function encodeRouteSeen(s: RouteSeenState): string {
  return JSON.stringify({ trackedSince: s.trackedSinceMs, lastNoted: s.lastNotedMs, seen: Object.fromEntries(s.seen) });
}

/** Restores the saved state; anything unreadable starts tracking afresh at `nowMs` (so nobody is demoted on a bad read). */
export function decodeRouteSeen(raw: string | undefined | null, nowMs: number): RouteSeenState {
  if (!raw) return { trackedSinceMs: nowMs, seen: new Map() };
  try {
    const j = JSON.parse(raw) as { trackedSince?: unknown; lastNoted?: unknown; seen?: Record<string, unknown> };
    const seen = new Map<string, number>();
    for (const [k, v] of Object.entries(j.seen ?? {})) if (typeof v === "number" && Number.isFinite(v)) seen.set(k, v);
    const since = typeof j.trackedSince === "number" && Number.isFinite(j.trackedSince) ? j.trackedSince : nowMs;
    const lastNotedMs = typeof j.lastNoted === "number" && Number.isFinite(j.lastNoted) ? j.lastNoted : undefined;
    return { trackedSinceMs: since, seen, ...(lastNotedMs !== undefined ? { lastNotedMs } : {}) };
  } catch {
    return { trackedSinceMs: nowMs, seen: new Map() };
  }
}
