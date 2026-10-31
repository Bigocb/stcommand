/**
 * Slowly cover the rest of a live system's worthwhile markets.
 *
 * A fresh system is queued with only its best few markets (freshKeepersPerSystem, 6 on 2026-10-29): the API allows 90 calls a
 * minute and every keeper uses some of them, so covering all 20 to 29 markets of a system at once is not affordable. The others
 * were never added to the keeper list, so nothing ever covered them. This picks ONE more market now and then, from a system that
 * is already live, only while the keeper polling load has room, the keeper limit is not reached and the list is not already
 * waiting on keepers to be bought. The caller adds the pick to the keeper priority list; the usual queue buys it (with the same
 * approval card or auto-approve cap as any keeper).
 *
 * Pure: no I/O, no clock, no globals. Policy is data (`TopUpPolicy`), backed by doctrine clauses; perHour 0 = off, which reproduces
 * today's behaviour. Every decision carries a one-line reason.
 */
export interface TopUpPolicy {
  /** Markets added per hour at most. 0 switches the feature off. */
  perHour: number;
  /** Ceiling for the keepers' own polling load, in calls a minute: the rest of the 90 is for trading, ships and surveys. */
  maxKeeperCalls: number;
  /** Do not add while this many listed markets still wait for a keeper to be bought. */
  maxPending: number;
}

export const DEFAULT_TOPUP_POLICY: TopUpPolicy = { perHour: 0, maxKeeperCalls: 60, maxPending: 3 };

export interface TopUpSystem {
  system: string;
  /** Markets of this system that already have a keeper (or are listed for one). */
  covered: number;
  /** Worthwhile markets not yet listed, best first. */
  candidates: readonly string[];
}

export interface TopUpContext {
  nowMs: number;
  /** When the last market was added, if ever. */
  lastAddMs?: number;
  /** Keepers stationed or on their way. */
  keepers: number;
  /** keeperMaxTotal; 0 = no limit. */
  max: number;
  /** The keepers' polling load now, calls a minute. */
  keeperCallsPerMin: number;
  /** What one more keeper adds, calls a minute (the fleet average). */
  callsPerKeeper: number;
  /** Listed markets still without a keeper. */
  pending: number;
}

export interface TopUpDecision {
  market?: string;
  system?: string;
  reason: string;
}

export function pickTopUp(systems: readonly TopUpSystem[], ctx: TopUpContext, policy: TopUpPolicy): TopUpDecision {
  if (policy.perHour <= 0) return { reason: "keeper top-up is off" };
  const gapMs = 3_600_000 / policy.perHour;
  if (ctx.lastAddMs !== undefined && ctx.nowMs - ctx.lastAddMs < gapMs) {
    return { reason: `last top-up ${Math.round((ctx.nowMs - ctx.lastAddMs) / 60_000)} min ago; one every ${Math.round(gapMs / 60_000)} min` };
  }
  if (ctx.pending >= policy.maxPending) return { reason: `${ctx.pending} listed market(s) still wait for a keeper (limit ${policy.maxPending})` };
  if (ctx.max > 0 && ctx.keepers >= ctx.max) return { reason: `keeper limit reached (${ctx.keepers} of ${ctx.max})` };
  const after = ctx.keeperCallsPerMin + ctx.callsPerKeeper;
  if (after > policy.maxKeeperCalls) {
    return { reason: `no API room: keepers poll ${ctx.keeperCallsPerMin.toFixed(1)} calls/min, one more would make ${after.toFixed(1)} against ${policy.maxKeeperCalls}` };
  }
  // The least-covered system first: the share of its worthwhile markets that already have a keeper.
  const open = systems.filter((s) => s.candidates.length > 0);
  if (!open.length) return { reason: "every live system's worthwhile markets are covered" };
  const share = (s: TopUpSystem): number => s.covered / (s.covered + s.candidates.length);
  const best = [...open].sort((a, b) => share(a) - share(b) || a.system.localeCompare(b.system))[0]!;
  const market = best.candidates[0]!;
  return { market, system: best.system, reason: `${market}: ${best.system} has ${best.covered} of ${best.covered + best.candidates.length} worthwhile markets covered; keepers poll ${ctx.keeperCallsPerMin.toFixed(1)} -> ${after.toFixed(1)} calls/min (ceiling ${policy.maxKeeperCalls})` };
}

/**
 * Listed markets that still wait for a keeper and so hold top-up back (TopUpPolicy.maxPending). Markets of a system that is still queued
 * (scouted or staged) do not count: staging lists its best markets for keepers at once, so with a few systems staged the count sat at
 * 20 or more and top-up added nothing for hours (2026-10-30, found when the live systems still had only the 6 markets they started with).
 */
export function pendingForTopUp(listed: Iterable<string>, covered: ReadonlySet<string>, queuedSystems: ReadonlySet<string>, systemOf: (market: string) => string): number {
  let n = 0;
  for (const m of listed) if (!covered.has(m) && !queuedSystems.has(systemOf(m))) n++;
  return n;
}

export interface CoverageRow {
  system: string;
  /** Markets that pass the goods filter (keeperMinGoods). */
  viable: number;
  /** Of those, with a keeper or listed for one. */
  covered: number;
  /** Viable markets neither covered nor listed: what top-up has still to add. */
  uncovered: number;
}

/** Live systems with the most viable markets still uncovered first (ops tool keeper_coverage). */
export function coverageRows(systems: readonly TopUpSystem[], viableOf: (system: string) => number): CoverageRow[] {
  return systems
    .map((s) => ({ system: s.system, viable: viableOf(s.system), covered: s.covered, uncovered: s.candidates.length }))
    .sort((a, b) => b.uncovered - a.uncovered || a.system.localeCompare(b.system));
}
