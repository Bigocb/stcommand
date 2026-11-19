/**
 * How much of a system's listed markets we have prices for: ever (`pricedPct`, what the release rule counts) and within the
 * last 90 minutes (`freshPct`, the age a price still defines a route). Shown per system on Tower's Expand cards (operator,
 * 2026-11-19). Pure: the caller passes the newest price time per market and `now`.
 */
export const FRESH_PRICE_MS = 90 * 60_000;

export function marketPricedShares(markets: readonly string[], newest: ReadonlyMap<string, number> | undefined, now: number): { pricedPct?: number; freshPct?: number } {
  if (!newest || markets.length === 0) return {};
  let priced = 0;
  let fresh = 0;
  for (const m of markets) {
    const t = newest.get(m);
    if (t === undefined) continue;
    priced++;
    if (now - t <= FRESH_PRICE_MS) fresh++;
  }
  return { pricedPct: Math.round((priced / markets.length) * 100), freshPct: Math.round((fresh / markets.length) * 100) };
}
