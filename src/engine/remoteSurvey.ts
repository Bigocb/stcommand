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
