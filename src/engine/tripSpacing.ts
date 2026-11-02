/**
 * Trip spacing: a minimum gap between the STARTS of trips that buy the same good at the same buy market.
 *
 * The round limits (routeRounds.ts) count trips when they CLOSE, so several ships can all start buying the same good before
 * any trip has closed and the limit has anything to count. 2026-11-02, after the CLOTHING and FABRICS chain had rested two
 * hours and recovered (FABRICS at E49 2,594 -> 2,097), three ships bought 40 units each in four minutes (19:26-19:30) at
 * 2,097, 2,260 and 2,447, and the recovery was spent. Our own buying lifts the ask 4 to 15% a lot, so the next buyer should
 * wait until the market has had time to move back.
 *
 * Pure: the caller passes the starts it has seen and the clock. `minGapMin` 0 switches it off. A ship's own start never
 * rests it (it is the one mid-trip), so the caller names it in `exceptShip`.
 */

export interface TripStart { good: string; buyAt: string; shipSymbol: string; at: number }
export interface SpacingPolicy { minGapMin: number }

/** Why this good at this buy market is resting under the spacing rule, or undefined when a trip may start. */
export function spacingReason(starts: readonly TripStart[], good: string, buyAt: string, now: number, policy: SpacingPolicy, exceptShip?: string): string | undefined {
  if (!(policy.minGapMin > 0)) return undefined;
  const since = now - policy.minGapMin * 60_000;
  const recent = starts.filter((s) => s.good === good && s.buyAt === buyAt && s.at >= since && s.shipSymbol !== exceptShip);
  if (recent.length === 0) return undefined;
  const latest = Math.max(...recent.map((s) => s.at));
  const sinceMin = Math.max(0, Math.round((now - latest) / 60_000));
  const leftMin = Math.max(1, Math.ceil((latest + policy.minGapMin * 60_000 - now) / 60_000));
  return `spacing: a trip bought ${good} at ${buyAt} ${sinceMin} min ago, next may start in ${leftMin} min (gap ${policy.minGapMin} min)`;
}
