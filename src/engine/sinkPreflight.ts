/**
 * Re-check the destination before cargo already bought is flown to it.
 *
 * Why it exists (2026-10-28): THEO-1E bought 40 GRAVITON_EMITTERS (1.35M) for KR9-A1, which bid 58k at the time. A rival sold 126 units into
 * KR9-A1 before the cargo got there; the bid fell to 25.7k and the cargo sold for 765k. The buy guards judge the destination once, at the buy
 * (buyGuard.ts), and the loss floor judges it again only on arrival, after the jumps and fuel were spent. Nothing looked in between.
 *
 * One rule: with the cargo in the hold, before each (re)departure toward the sell market, take the destination's bid, discount it for the lots
 * this cargo will be sold in (the same per-lot impact the buy guard uses), and compare it with the loss floor, cost less the allowed loss.
 * Under the floor: don't go (redirect to a better market, or hold and look again).
 *
 * Pure: the caller reads the bid (a fresh stored snapshot, since a market far away shows no prices to a ship that is not there) and passes
 * what it saw. No bid, or impact 0, judges nothing: that is today's behaviour.
 */
export interface SinkPreflightInput {
  /** What the cargo cost per unit. */
  costPerUnit: number;
  units: number;
  /** Units the market takes per sale; the cargo is sold in ceil(units / lotSize) lots. */
  lotSize: number;
  /** The destination's bid, or undefined when no fresh reading exists. */
  bid: number | undefined;
  /** Expected price move per lot as a fraction (the buy guard's impact percent / 100). 0 or less = off. */
  impactPerLot: number;
  /** The most loss, in percent of cost, a sale may take (doctrine maxLossPct). */
  maxLossPct: number;
}

export interface SinkPreflightVerdict {
  ok: boolean;
  /** One line for the log. */
  reason: string;
}

const c = (n: number) => Math.round(n).toLocaleString("en-US");

export function sinkPreflight(i: SinkPreflightInput): SinkPreflightVerdict {
  if (!(i.impactPerLot > 0)) return { ok: true, reason: "guard off" };
  if (i.bid === undefined || !(i.bid > 0)) return { ok: true, reason: "destination bid unknown: not judged" };
  if (!(i.costPerUnit > 0) || !(i.units > 0)) return { ok: true, reason: "no cost basis: not judged" };
  const lots = Math.max(1, Math.ceil(i.units / Math.max(1, i.lotSize)));
  // The average unit sits in the middle of the lots: lot k of n is sold after k-1 steps of impact.
  const expected = i.bid * (1 - i.impactPerLot * ((lots - 1) / 2));
  const floor = i.costPerUnit * (1 - Math.max(0, i.maxLossPct) / 100);
  if (expected < floor) {
    return { ok: false, reason: `destination bids ${c(i.bid)}c, about ${c(expected)}c a unit over ${lots} lot(s), under the loss floor ${c(floor)}c (cost ${c(i.costPerUnit)}c, ${i.maxLossPct}% allowed)` };
  }
  return { ok: true, reason: `destination bids ${c(i.bid)}c, about ${c(expected)}c a unit over ${lots} lot(s), floor ${c(floor)}c` };
}
