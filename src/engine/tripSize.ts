/**
 * How big a trip to plan: the full load if it pays, otherwise one lot less, and so on.
 *
 * A trader sized every trip at its ceiling (the hold, the wallet and a few lots) and rejected the route when that size lost
 * money. Our own price impact grows with the square of the units, so on a 490-hold freighter the ceiling (about 480 units)
 * often loses on a route that pays well at 100 or 200: on 2026-10-29 THEO-EE and THEO-AB rejected 24 of 27 assignments in
 * half an hour (CLOTHING -316k, FOOD -193k at full size) and THEO-EE went almost two hours without a sale. The 80-hold
 * haulers never reached the losing sizes. Operator's rule (2026-10-29): start at the full load, and if it isn't
 * profitable step down one lot and try again.
 *
 * Pure: no I/O. `profitAt` is the caller's own trip estimate for a given number of units.
 */
export interface TripSize {
  /** Units to plan, or 0 when not even one lot pays. */
  units: number;
  /** The estimate at that size (at one lot when nothing pays). */
  profit: number;
  /** How many one-lot steps down from the full load it took (0 = the full load paid). */
  steps: number;
}

export function sizeTrip(maxUnits: number, lotSize: number, profitAt: (units: number) => number): TripSize {
  if (!(maxUnits > 0) || !(lotSize > 0)) return { units: 0, profit: 0, steps: 0 };
  let units = Math.floor(maxUnits);
  let steps = 0;
  let profit = profitAt(units);
  while (profit <= 0) {
    // The next size down is the lot boundary below this one: 480 -> 420 -> ... with 60-unit lots, 80 -> 60 -> ... with 20.
    const next = (Math.ceil(units / lotSize) - 1) * lotSize;
    if (next <= 0) return { units: 0, profit, steps };
    units = next;
    steps += 1;
    profit = profitAt(units);
  }
  return { units, profit, steps };
}
