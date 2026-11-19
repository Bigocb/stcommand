/**
 * How much of a cross-system route's score the jumps to reach its buy market should take off.
 *
 * Why it exists (2026-11-19): the dispatcher scores a route as a RATE (profit per 600 s of trip time, scoreRoute()), discounts it
 * for the time spent reaching the buy market, and then subtracted the positioning jump fees as a LUMP of credits. A rate minus a
 * lump: ANTIMATTER AB12-Z25E -> XS51-F23F, 160,578 a trip over ~54 min, scored 29,737 per 600 s; for THEO-A7, 5 jumps (~33k)
 * away, the check read 29.7k x (time discount) - 33k < 0 and refused a trip that really nets ~127k after the jumps. Every rich
 * route 4+ jumps away was refused for every ship; it bit hard in a week whose rich systems were 4-6 jumps apart.
 *
 * Scaled (clause positioningCostScaled on): the fee is put on the same scale as the score, fee x 600 / (trip + positioning)
 * seconds, so the result is (profit - fee) per 600 s of the whole trip. Off, or a route without a trip time (its score is not
 * time-scaled): the fee comes off in full, exactly as before.
 *
 * Pure: no I/O, no clock.
 */

export interface PositioningCostPolicy {
  /** On = scale the fee like the score. Off = the old lump subtraction. */
  scaled: boolean;
  /** The reference trip length the score is scaled to (REFERENCE_TRIP_SECONDS). */
  referenceSeconds: number;
}

/** The amount to subtract from a route's (time-scaled) score for `credits` of positioning jump fees. */
export function positioningCharge(credits: number, tripSeconds: number | undefined, positioningSeconds: number, policy: PositioningCostPolicy): number {
  if (!(credits > 0)) return 0;
  if (!policy.scaled || !tripSeconds || tripSeconds <= 0) return credits;
  return (credits * policy.referenceSeconds) / (tripSeconds + Math.max(0, positioningSeconds));
}

/**
 * The trip profit to test "does the first trip cover the positioning jumps" against. The work item's `profitPerTrip` is the
 * time-scaled score (profit per 600 s), not a trip's profit, so comparing it with a jump bill refused long rich trips the same
 * way (29,737 vs 33k for a 160,578 trip). On: the route's real profit per trip when known. Off: the old score.
 */
export function tripProfitForPositioning(score: number | undefined, rawProfit: number | undefined, policy: Pick<PositioningCostPolicy, "scaled">): number {
  if (policy.scaled && rawProfit !== undefined) return rawProfit;
  return score ?? 0;
}
