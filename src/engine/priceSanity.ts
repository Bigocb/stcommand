// A plan-time check on the price a route expects to be paid. Pure: the bid history comes in as a map.
//
// Why: 2026-11-01 THEO-2B0 bought 72 CYBER_IMPLANTS at about 33,000 for X1-RB80-A1 on the strength of one reading that
// showed a bid of 42,430 there. Minutes after the purchase the market read 11,838 (its bids sat between 10,900 and
// 28,000 all day) and the trip lost 1.53 million. A route is built from each market's newest snapshot, so one bad or
// transient reading is enough to send a 2-million hold. The check compares the planned sell price with the same market's
// own recent middle (median) bid and rejects a route that counts on a price far above it.
//
// It judges only a market with enough history, against its own history and not the good's price elsewhere: the best
// buyers of a good are meant to pay more than the median market, and the route finder is looking for exactly those.

export interface BidStat {
  /** The market's median bid for the good over the history window. */
  median: number;
  /** Readings behind the median. */
  samples: number;
}

export interface SanityPolicy {
  /** Reject when the planned sell price is more than this many times the market's own median bid (2 = twice). */
  maxOverMedian: number;
  /** Fewer readings than this and the market is not judged. */
  minSamples: number;
}

export const DEFAULT_SANITY: SanityPolicy = { maxOverMedian: 2, minSamples: 4 };

export type SanityVerdict = { ok: true } | { ok: false; reason: string };

export const bidKey = (waypoint: string, good: string): string => `${waypoint}|${good}`;

export function sellPriceVerdict(route: { good: string; sellAt: string; sellPrice: number }, stats: ReadonlyMap<string, BidStat>, policy: SanityPolicy = DEFAULT_SANITY): SanityVerdict {
  if (!(policy.maxOverMedian > 0)) return { ok: true };
  const s = stats.get(bidKey(route.sellAt, route.good));
  if (!s || s.samples < policy.minSamples || !(s.median > 0)) return { ok: true };
  if (route.sellPrice <= s.median * policy.maxOverMedian) return { ok: true };
  const x = route.sellPrice / s.median;
  return { ok: false, reason: `${route.good} at ${route.sellAt}: planned bid ${Math.round(route.sellPrice)} is ${x.toFixed(1)}x its own median ${Math.round(s.median)} over ${s.samples} readings` };
}
