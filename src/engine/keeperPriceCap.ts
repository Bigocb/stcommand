/**
 * Keeper probe price cap (clause keeperMaxProbePrice, operator 2026-11-19). A probe normally costs about 20-35k, but some yards price it
 * far higher: THEO-BA cost 161,774 at X1-TU72-C40 (TU72's yards ask 161-280k), when one delivered from another yard would have cost about
 * 40k. A yard asking more than the cap is not used for a keeper probe; the market path falls back to a delivery from a yard under it.
 * Pure.
 */

/** cap <= 0 = no cap. */
export function overProbeCap(price: number, cap: number): boolean {
  return cap > 0 && price > cap;
}

/** The yard rows a keeper probe may be bought from: keeper hulls over the cap are dropped, every other row is kept. */
export function withinProbeCap<T extends { shipType: string; purchasePrice: number }>(rows: readonly T[], cap: number, keeperHulls: readonly string[]): T[] {
  if (cap <= 0) return [...rows];
  return rows.filter((r) => !keeperHulls.includes(r.shipType) || r.purchasePrice <= cap);
}
