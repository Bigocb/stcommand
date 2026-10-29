/**
 * How big a trip to plan: walk back from the full load one lot at a time and stop at the most profitable size.
 *
 * A trader sized every trip at its ceiling (the hold, the wallet and a few lots) and rejected the route when that size lost
 * money. Our own price impact grows with the square of the units, so on a 490-hold freighter the ceiling (about 480 units)
 * often loses on a route that pays well at 100 or 200: on 2026-10-29 THEO-EE and THEO-AB rejected 24 of 27 assignments in
 * half an hour (CLOTHING -316k, FOOD -193k at full size) and THEO-EE went almost two hours without a sale.
 *
 * Operator's rule (2026-10-29): start at the full load and step down one lot at a time. It keeps stepping while the profit
 * still rises and stops where it starts to fall, so a route that barely breaks even at 420 units is flown at the 240 that
 * earns the most, not at 420. A trip takes about the same time whatever the load, so the most profitable trip is also the
 * most profitable hour on that route; the route board sizes trips the same way (sizeForImpact), so the trader now flies
 * the size the dispatcher priced.
 *
 * Pure: no I/O. `profitAt` is the caller's own trip estimate for a given number of units.
 */
export interface TripSize {
  /** Units to plan, or 0 when not even one lot pays. */
  units: number;
  /** The estimate at that size (the best seen when nothing pays). */
  profit: number;
  /** How many one-lot steps down from the full load the chosen size is (0 = the full load). */
  steps: number;
}

export function sizeTrip(maxUnits: number, lotSize: number, profitAt: (units: number) => number): TripSize {
  if (!(maxUnits > 0) || !(lotSize > 0)) return { units: 0, profit: 0, steps: 0 };
  let units = Math.floor(maxUnits);
  let best: TripSize = { units, profit: profitAt(units), steps: 0 };
  for (let steps = 1; ; steps += 1) {
    // The next size down is the lot boundary below this one: 480 -> 420 -> ... with 60-unit lots, 80 -> 60 -> ... with 20.
    units = (Math.ceil(units / lotSize) - 1) * lotSize;
    if (units <= 0) break;
    const profit = profitAt(units);
    if (profit > best.profit) best = { units, profit, steps };
    // Past the top: profit has started to fall again, and the impact model only makes it fall further from here.
    else if (best.profit > 0) break;
  }
  return best.profit > 0 ? best : { units: 0, profit: best.profit, steps: best.steps };
}
