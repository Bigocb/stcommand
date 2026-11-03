/**
 * Which systems the remote surveyor reads next.
 *
 * A survey is only API calls (waypoints with traits, each market's goods lists, each yard's hull-type list), so the box can do it
 * for any system whose gate is finished without a ship going there. This picks which: systems reachable now that no read has
 * covered yet, nearest the systems we already work first. Pure; the caller supplies the sets.
 */
export interface RemoteSurveyPolicy {
  /** Systems read per pass. 0 switches the surveyor off. */
  perPass: number;
}

export const DEFAULT_REMOTE_SURVEY_POLICY: RemoteSurveyPolicy = { perPass: 0 };

export interface RemoteSurveyContext {
  /** Systems reachable through finished gates, with the gate hops from the nearest system we already work in. */
  reachable: ReadonlyMap<string, number>;
  /** Systems a read has already covered (the saved market directory has rows for them). */
  alreadyRead: ReadonlySet<string>;
  /** Systems a read failed for recently, with the time (ms) it may be tried again. */
  retryAt: ReadonlyMap<string, number>;
  nowMs: number;
}

export function pickRemoteSurveys(ctx: RemoteSurveyContext, policy: RemoteSurveyPolicy): string[] {
  if (policy.perPass <= 0) return [];
  return [...ctx.reachable.entries()]
    .filter(([system]) => !ctx.alreadyRead.has(system) && (ctx.retryAt.get(system) ?? 0) <= ctx.nowMs)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, policy.perPass)
    .map(([system]) => system);
}

/**
 * While every gate in the home system is still under construction nothing is reachable, so the walk through finished gates finds
 * nothing and the queue stays empty until the gate opens (2026-11-03: gate at 360/400 of ADVANCED_CIRCUITRY, DJ62 and AB82 unread).
 * Reading is only API calls and scouting buys nothing, so the systems directly across a closed home gate may be read and queued
 * as "scouted" ahead of time. Staging stays blocked by the release rule (fleet.ts: a closed home gate makes every queued system
 * unreachable). With the gate open, or when `neighbours` is empty, the map comes back unchanged. A system already in the map keeps its hops.
 */
export function withClosedGateNeighbours(reachable: ReadonlyMap<string, number>, neighbours: readonly string[], homeGateClosed: boolean): Map<string, number> {
  const out = new Map(reachable);
  if (!homeGateClosed) return out;
  for (const s of neighbours) if (!out.has(s)) out.set(s, 1);
  return out;
}

/**
 * Did a read of a system's markets come back far short of what its waypoint traits list? Under half is a failed read, not a small system
 * (a failed per-market read is skipped, so rate limiting returns what it got). Nothing expected = nothing to compare.
 */
export function readIncomplete(expectedMarkets: number, gotMarkets: number): boolean {
  return expectedMarkets > 0 && gotMarkets * 2 < expectedMarkets;
}
