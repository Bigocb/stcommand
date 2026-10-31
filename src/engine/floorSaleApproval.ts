/**
 * May a below-floor sale go ahead without an approval card?
 *
 * A lot held under its loss floor waits for the operator (trader.floorSaleApproved), and a denied or unanswered card leaves the ship
 * holding cargo for hours (2026-10-31: nobody awake overnight, cards expire in 30 minutes). Two cases need different answers: a
 * market paying a real share of the cost basis is a loss worth taking so the ship works again, while a market paying next to nothing
 * (THEO-9E: 1c on a 17,851c basis) is a broken market, and selling there throws the cargo away.
 *
 * So the sale is approved only when the market pays at least `minSharePct` of the cost basis and the loss on this one sale is at most
 * `maxLossCredits`. Anything else stays a card (and the ship holds, or is redirected).
 *
 * Pure: no I/O, no clock. Policy is data, backed by doctrine clauses; `enabled` false reproduces today's behaviour (every
 * below-floor sale asks the operator). Every decision carries a one-line reason.
 */
export interface FloorSalePolicy {
  enabled: boolean;
  /** The market must pay at least this percent of the cost basis per unit. */
  minSharePct: number;
  /** The loss on the sale (cost basis minus price, times units) must not exceed this. 0 = no credit cap. */
  maxLossCredits: number;
}

export const NO_FLOOR_AUTO_APPROVE: FloorSalePolicy = { enabled: false, minSharePct: 100, maxLossCredits: 0 };

export interface FloorSaleFacts {
  /** The price per unit the market pays now. */
  live: number;
  /** Cost basis per unit; undefined when unknown. */
  cost: number | undefined;
  units: number;
}

export function floorSaleAutoApprove(f: FloorSaleFacts, p: FloorSalePolicy): { approve: boolean; reason: string } {
  if (!p.enabled) return { approve: false, reason: "automatic below-floor sales are off: the operator decides" };
  if (f.cost === undefined || !(f.cost > 0)) return { approve: false, reason: "no cost basis on file: the operator decides" };
  if (!Number.isFinite(f.live) || f.live <= 0 || f.units <= 0) return { approve: false, reason: `${f.live}c is not a real quote` };
  const share = (f.live / f.cost) * 100;
  if (share < p.minSharePct) return { approve: false, reason: `the market pays ${share.toFixed(0)}% of cost, under the ${p.minSharePct}% minimum` };
  const loss = Math.max(0, (f.cost - f.live) * f.units);
  if (p.maxLossCredits > 0 && loss > p.maxLossCredits) return { approve: false, reason: `the loss ${Math.round(loss)}c is over the ${p.maxLossCredits}c cap` };
  return { approve: true, reason: `pays ${share.toFixed(0)}% of cost, loss ${Math.round(loss)}c within the cap` };
}
