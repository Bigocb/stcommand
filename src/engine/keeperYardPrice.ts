/**
 * The price a keeper hull will really cost at a yard, for the auto-approve cap and for picking the cheapest yard.
 *
 * The keeper buyer priced every purchase from the stored yard snapshot, which is read when a ship docks there (at most every
 * 30 minutes). Each purchase raises the yard's price, and nothing updated the snapshot in between, so a burst of purchases at one
 * yard all looked as cheap as the first. 2026-11-05 22:59-23:08: staging AR4, HH6 and JK34 bought 25 probes at X1-SQ43-ZZ6Z, each
 * logged "for 24089 credits"; the ledger shows 46,393 rising to 96,476, about 1.5M against the 0.6M the engine thought, and most of
 * them over the 60,000 auto-approve cap that should have stopped them.
 *
 * The rule: the price of a hull at a yard is the stored price or the last price we actually paid there for that hull, whichever is
 * higher, while that payment is recent (`windowMs`). A purchase is the freshest reading of the yard there is.
 *
 * Pure: no clock, no I/O.
 */

export interface PaidPrice {
  /** Credits the last purchase of this hull at this yard actually cost. */
  price: number;
  /** When it was paid, epoch ms. */
  at: number;
}

export function yardPaidKey(waypoint: string, hull: string): string {
  return `${waypoint}|${hull}`;
}

/** The higher of the stored price and a recent purchase price. */
export function keeperYardPrice(stored: number, paid: PaidPrice | undefined, nowMs: number, windowMs: number): number {
  if (!paid || nowMs - paid.at > windowMs) return stored;
  return Math.max(stored, paid.price);
}
