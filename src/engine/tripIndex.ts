/**
 * Trip history grouped by route and by buy market, built once per dispatcher pass (2026-11-28).
 *
 * The route rest checks (cool-off, rounds, buy-market rounds, spacing) each filter the whole trip list by good and
 * market. The dispatcher ran them for every route on every pass: with 321 live systems that was thousands of routes
 * times about 400 trip records, about 10% of the box's CPU in a profile on 2026-11-28 04:12. Each check only ever looks
 * at the records of its own (good, buyAt[, sellAt]), so handing it that subset gives the same answer. Pure.
 */
import type { RouteTrip } from "./routeHeat.js";
import type { TripStart } from "./tripSpacing.js";

const EMPTY: readonly never[] = Object.freeze([]);

export interface TripIndex {
  /** Closed trips on exactly this good, buy market and sell market. */
  route(good: string, buyAt: string, sellAt: string): readonly RouteTrip[];
  /** Closed trips that bought this good at this market, whatever they sold into. */
  buy(good: string, buyAt: string): readonly RouteTrip[];
  /** Trip starts for this good at this buy market. */
  starts(good: string, buyAt: string): readonly TripStart[];
}

function push<T>(map: Map<string, T[]>, key: string, v: T): void {
  const list = map.get(key);
  if (list) list.push(v);
  else map.set(key, [v]);
}

/** Group the lists, keeping each group in the original order. */
export function buildTripIndex(trips: readonly RouteTrip[], starts: readonly TripStart[]): TripIndex {
  const byRoute = new Map<string, RouteTrip[]>();
  const byBuy = new Map<string, RouteTrip[]>();
  const startsByBuy = new Map<string, TripStart[]>();
  for (const t of trips) {
    push(byRoute, `${t.good}|${t.buyAt}|${t.sellAt}`, t);
    push(byBuy, `${t.good}|${t.buyAt}`, t);
  }
  for (const s of starts) push(startsByBuy, `${s.good}|${s.buyAt}`, s);
  return {
    route: (good, buyAt, sellAt) => byRoute.get(`${good}|${buyAt}|${sellAt}`) ?? EMPTY,
    buy: (good, buyAt) => byBuy.get(`${good}|${buyAt}`) ?? EMPTY,
    starts: (good, buyAt) => startsByBuy.get(`${good}|${buyAt}`) ?? EMPTY,
  };
}
