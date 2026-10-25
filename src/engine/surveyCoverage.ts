/**
 * Which markets of a system still need a ship to price them. Pure.
 *
 * A remote market read gives a market's goods lists with no ship there; prices need a visit (or a keeper). A market is worth
 * surveying when it trades at least `minGoods` goods (the keeper minimum, so the survey covers exactly the markets a keeper
 * could be worth buying for) or when its goods count is not known yet (never dropped on a guess, same rule as splitThinMarkets).
 */
export function unpricedMarkets(
  marketplaces: readonly string[],
  goodsOf: (market: string) => number | undefined,
  priced: ReadonlySet<string>,
  minGoods: number,
): { total: number; missing: string[] } {
  const worth = marketplaces.filter((m) => {
    const g = goodsOf(m);
    return g === undefined || g >= minGoods;
  });
  return { total: worth.length, missing: worth.filter((m) => !priced.has(m)) };
}

/** Share of a gate's materials delivered, rounded down to a whole percent, so 99.9% never reads as 100 (done is decided by the gate itself). */
export function gateProgressPct(fulfilled: number, required: number): number {
  if (!(required > 0)) return 0;
  return Math.max(0, Math.min(99, Math.floor((100 * fulfilled) / required)));
}
