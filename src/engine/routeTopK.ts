/**
 * Price only the legs that can make a good's top N (issue #88, P4).
 *
 * The route build priced every stored leg: on 2026-11-27 321,799 legs a build, 20.7 s of a 40 s build, and kept about 280,000
 * routes that the dispatcher (which reserves a direct route's whole good, so it takes the best few per good), the Markets screen
 * and /api/dispatch then walked. Each leg has a cheap upper bound on its profit (`ceiling`: margin x the largest load it could
 * carry, less its fixed fuel or jump cost; routePrefilter.ts netCeiling) and an exact trip time (`seconds`), and pricing never
 * yields more than the ceiling (units are only ever cut and slippage only subtracted). So, per good, legs are priced best ceiling
 * first and pricing stops once no unpriced leg could beat the N-th best priced one, once by profit per trip and once by profit
 * per hour (ceiling over time). The result holds each good's exact top N on both rankings.
 *
 * Pure: the caller passes the legs' bounds and a price function; `pause` lets it yield to the event loop every `yieldEvery`
 * pricings.
 */
export interface LegBound {
  good: string;
  /** Upper bound on profit per trip (credits). */
  ceiling: number;
  /** Exact trip time used for the per-hour rank, seconds; undefined = ranked on profit alone (as routePerHour does). */
  seconds?: number;
}

export interface TopKResult<R> {
  /** Priced routes, by leg index; legs never priced are absent. */
  priced: Map<number, R | null>;
  /** Legs skipped because they could not reach a good's top N on either rank. */
  skipped: number;
}

export interface TopKOptions<R> {
  perGood: number;
  /** Price leg `i`; null = the leg turned out unusable. */
  price: (i: number) => R | null;
  /** Profit per trip of a priced route. */
  profitOf: (r: R) => number;
  /** The per-hour rank of a priced route (the same formula the caller sorts by). */
  rateOf: (r: R) => number;
  /** The per-hour rank's upper bound for a leg, from its ceiling and seconds. */
  rateBound: (b: LegBound) => number;
  yieldEvery?: number;
  pause?: () => Promise<void>;
}

/** Insert v into a descending top-n list. */
function pushTop(top: number[], v: number, n: number): void {
  let i = top.length;
  while (i > 0 && top[i - 1]! < v) i--;
  top.splice(i, 0, v);
  if (top.length > n) top.length = n;
}

export async function priceTopPerGood<R>(bounds: readonly LegBound[], o: TopKOptions<R>): Promise<TopKResult<R>> {
  const n = Math.max(1, Math.floor(o.perGood));
  const byGood = new Map<string, number[]>();
  bounds.forEach((b, i) => { (byGood.get(b.good) ?? byGood.set(b.good, []).get(b.good)!).push(i); });
  const priced = new Map<number, R | null>();
  let count = 0;
  const priceOne = async (i: number): Promise<R | null> => {
    if (priced.has(i)) return priced.get(i)!;
    const r = o.price(i);
    priced.set(i, r);
    count++;
    if (o.pause && o.yieldEvery && count % o.yieldEvery === 0) await o.pause();
    return r;
  };
  for (const idx of byGood.values()) {
    // Rank 1: profit per trip.
    const byCeiling = [...idx].sort((a, b) => bounds[b]!.ceiling - bounds[a]!.ceiling);
    const topProfit: number[] = [];
    for (const i of byCeiling) {
      if (topProfit.length >= n && bounds[i]!.ceiling <= topProfit[n - 1]!) break;
      const r = await priceOne(i);
      if (r !== null) { const p = o.profitOf(r); if (p > 0) pushTop(topProfit, p, n); }
    }
    // Rank 2: profit per hour.
    const byRate = [...idx].sort((a, b) => o.rateBound(bounds[b]!) - o.rateBound(bounds[a]!));
    const topRate: number[] = [];
    for (const i of byRate) {
      if (topRate.length >= n && o.rateBound(bounds[i]!) <= topRate[n - 1]!) break;
      const r = await priceOne(i);
      if (r !== null && o.profitOf(r) > 0) pushTop(topRate, o.rateOf(r), n);
    }
  }
  return { priced, skipped: bounds.length - priced.size };
}
