/**
 * A cheap test that rules out a trade leg before it is priced in full.
 *
 * computeDispatchRoutes prices every stored leg (about 110,000 on 2026-11-06, one per buy/sell market pair that has a spread) and
 * then drops about 89% of them as "not profitable after fuel, slippage and jump costs". Pricing a leg is the expensive part
 * (two impact lookups, the thin-market rule, the size search, the trip economics once for the headline and once for each hold
 * size flying), and the route pass was the biggest block of the server's event loop (profiled 2026-11-06).
 *
 * A leg's net profit is gross - fuel/jump cost - slippage, where gross = margin x units, slippage >= 0 (every impact is at
 * least the default, lotImpact.ts) and the units are never above `unitsCeiling` (the smallest of hold, credits and lots).
 * So margin x unitsCeiling - fixedCost is a ceiling on the net; a leg whose ceiling is not above zero cannot be profitable and
 * is dropped for the same reason the full pricing would give. Pure: numbers in, a verdict out. The fixed cost is the part
 * of the cost that does not depend on the units: the jump cost across systems, the fuel for a same-system round trip.
 */

export interface PrefilterInput {
  buyPrice: number;
  sellPrice: number;
  /** The most units the trip could carry: min(hold, affordable, lot x max lots, thin-market cap). */
  unitsCeiling: number;
  /** Credits the trip costs whatever the units: the jump cost across systems, the round-trip fuel inside one. */
  fixedCost: number;
}

/** The most a trip on this leg could net: spread on the largest possible load, less its fixed cost, with no slippage. */
export function netCeiling(i: PrefilterInput): number {
  return (i.sellPrice - i.buyPrice) * Math.max(0, i.unitsCeiling) - Math.max(0, i.fixedCost);
}

/** True when the leg cannot net more than zero, so it can be dropped without being priced. */
export function cannotProfit(i: PrefilterInput): boolean {
  return Math.round(netCeiling(i)) <= 0;
}
