/**
 * Keeper triage: park a keeper whose market is not earning its polling, and come back later to see whether the market recovered.
 *
 * A keeper reads its market every 5 to 30 minutes and the API allows about 90 calls a minute fleet-wide, so a keeper on a market
 * nobody trades is a call that a keeper on a fresh system could use (docs/fresh-system-expansion-plan.md). Parking stops the
 * polling and frees a slot under keeperMaxTotal, keeps the hull, and is reversible, so it is the right first step; scrapping is
 * left to the operator.
 *
 * Two decisions, both pure (no I/O, no clock):
 *  - triageKeepers(): which stationed keepers to park now, and why. A keeper is a candidate only when no route through its market
 *    is viable right now AND either the market has never seen a trade of ours and scores well below the median ("low market"),
 *    or it traded before but has been quiet for a long while ("quiet market"; when every route through it is dead that is a
 *    crashed one). A keeper with an open reminder is left alone.
 *  - reviewParked(): when a reminder fires, whether to bring the keeper back (routes viable again, or a trade since), let it
 *    probe (no fresh read to judge by, so unpark it for one cycle and look again), look again later with a longer wait, or stop
 *    looking and say the market is settled dead.
 *
 * Policy is data; `maxParksPerRun` 0 switches the whole thing off and reproduces today's behaviour (nothing is parked).
 * Every decision carries a one-line reason.
 */

export interface TriagePolicy {
  /** Most keepers parked in one pass; 0 = off. */
  maxParksPerRun: number;
  /** Engine-parked keepers may be at most this share of the stationed ones. */
  maxParkedShare: number;
  /** Quiet this long counts as a quiet market. */
  idleMs: number;
  /** A never-traded market is "low" when its score is under this fraction of the median keeper score. */
  lowScoreRatio: number;
  /** No triage until the week is this old: before that every market looks untraded. */
  minWeekAgeMs: number;
  /** First look-again delay; it doubles after each look that finds the market still dead. */
  recheckMs: number;
  /** After unparking to probe, look again after this long. */
  probeMs: number;
  /** Looks before the keeper is left parked for good. */
  maxRechecks: number;
  /** A market read older than this cannot say whether the market recovered. */
  staleSnapshotMs: number;
}

export const OFF_POLICY: TriagePolicy = {
  maxParksPerRun: 0,
  maxParkedShare: 0.15,
  idleMs: 6 * 3_600_000,
  lowScoreRatio: 0.5,
  minWeekAgeMs: 24 * 3_600_000,
  recheckMs: 90 * 60_000,
  probeMs: 30 * 60_000,
  maxRechecks: 3,
  staleSnapshotMs: 90 * 60_000,
};

export interface KeeperFacts {
  ship: string;
  market: string;
  /** Keeper score of the market (keeperValue.ts); undefined = nothing known about what it trades. */
  score?: number;
  /** Trades of ours at the market this week (sells + buys). */
  trades: number;
  /** When we last traded there, ms; undefined = never this week. */
  lastTradeAt?: number;
  /** Routes the dispatcher holds now that buy or sell at this market. */
  viableRoutes: number;
  /** Routes held back as dead that touch this market. */
  deadRoutes: number;
}

export interface ParkDecision {
  ship: string;
  market: string;
  kind: "low" | "quiet" | "crashed";
  reason: string;
}

export function medianOf(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

function hours(ms: number): string {
  return `${Math.round(ms / 360_000) / 10}h`;
}

export function triageKeepers(i: {
  now: number;
  /** Age of the current week (since its reset), ms; undefined = unknown, which means no triage. */
  weekAgeMs: number | undefined;
  stationed: readonly KeeperFacts[];
  /** Ships the engine already parked (and so counts against the share cap). */
  alreadyParked: number;
  /** Ships to leave alone: an open reminder, a keeper bought a moment ago, anything the caller protects. */
  skip: ReadonlySet<string>;
  policy: TriagePolicy;
}): { park: ParkDecision[]; skipped: string } {
  const p = i.policy;
  if (!(p.maxParksPerRun > 0)) return { park: [], skipped: "keeper triage is off" };
  if (i.weekAgeMs === undefined) return { park: [], skipped: "the week's start is not known yet" };
  if (i.weekAgeMs < p.minWeekAgeMs) return { park: [], skipped: `the week is ${hours(i.weekAgeMs)} old, triage waits for ${hours(p.minWeekAgeMs)}` };
  const room = Math.floor(i.stationed.length * p.maxParkedShare) - i.alreadyParked;
  if (room <= 0) return { park: [], skipped: `${i.alreadyParked} engine-parked keepers is already ${Math.round(p.maxParkedShare * 100)}% of ${i.stationed.length}` };
  const median = medianOf(i.stationed.map((k) => k.score).filter((s): s is number => s !== undefined));

  const found: (ParkDecision & { rank: number })[] = [];
  for (const k of i.stationed) {
    if (i.skip.has(k.ship) || k.viableRoutes > 0) continue;
    if (k.trades === 0) {
      if (k.score === undefined || median === undefined || !(k.score < median * p.lowScoreRatio)) continue;
      found.push({
        ship: k.ship, market: k.market, kind: "low", rank: k.score,
        reason: `no trade of ours here this week, no viable route through it, and a score of ${k.score} against a median of ${Math.round(median * 10) / 10}`,
      });
      continue;
    }
    const quietFor = k.lastTradeAt === undefined ? Infinity : i.now - k.lastTradeAt;
    if (quietFor < p.idleMs) continue;
    const crashed = k.deadRoutes > 0;
    found.push({
      ship: k.ship, market: k.market, kind: crashed ? "crashed" : "quiet", rank: (k.score ?? 0) + 1e6,
      reason: `${crashed ? `every route through it is held back as dead (${k.deadRoutes}), ` : "no viable route through it, "}and no trade of ours for ${Number.isFinite(quietFor) ? hours(quietFor) : "a long while"}`,
    });
  }
  // Never-traded low scorers first (lowest score), then quiet ones.
  found.sort((a, b) => a.rank - b.rank || a.market.localeCompare(b.market));
  const take = Math.min(p.maxParksPerRun, room);
  return { park: found.slice(0, take).map(({ rank: _rank, ...d }) => d), skipped: "" };
}

export interface ParkedFacts {
  ship: string;
  market: string;
  /** Looks already made that found it dead. */
  rechecks: number;
  parkedAt: number;
  /** True when this look follows a probe (the keeper was unparked to read the market once). */
  probed: boolean;
  viableRoutes: number;
  lastTradeAt?: number;
  /** Age of the newest stored read of this market, ms; undefined = no read at all. */
  snapshotAgeMs?: number;
}

export type ReviewDecision =
  | { kind: "unpark"; reason: string }
  /** No fresh read to judge by: unpark it, let it read, and look again after `remindInMs`. */
  | { kind: "probe"; reason: string; remindInMs: number }
  /** Still dead: stay parked, look again after `remindInMs`. */
  | { kind: "extend"; reason: string; remindInMs: number; rechecks: number }
  /** Stop looking: left parked for good. */
  | { kind: "settle"; reason: string };

export function reviewParked(f: ParkedFacts, policy: TriagePolicy, now: number): ReviewDecision {
  if (f.viableRoutes > 0) return { kind: "unpark", reason: `${f.viableRoutes} route(s) through ${f.market} are viable again` };
  if (f.lastTradeAt !== undefined && f.lastTradeAt > f.parkedAt) return { kind: "unpark", reason: `we traded at ${f.market} after it was parked` };
  const stale = f.snapshotAgeMs === undefined || f.snapshotAgeMs > policy.staleSnapshotMs;
  if (stale && !f.probed) {
    return { kind: "probe", reason: `no read of ${f.market} in the last ${hours(policy.staleSnapshotMs)}, so it cannot be judged: unparking for one cycle`, remindInMs: policy.probeMs };
  }
  const rechecks = f.rechecks + 1;
  if (rechecks >= policy.maxRechecks) {
    return { kind: "settle", reason: `${f.market} still has no viable route after ${rechecks} look(s) since ${hours(now - f.parkedAt)} ago: leaving ${f.ship} parked (a candidate to scrap)` };
  }
  return {
    kind: "extend",
    rechecks,
    remindInMs: policy.recheckMs * 2 ** rechecks,
    reason: `${f.market} still has no viable route (look ${rechecks} of ${policy.maxRechecks})`,
  };
}
