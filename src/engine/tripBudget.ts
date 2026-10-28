/**
 * How much cash one trade's buying may use.
 *
 * Why it exists (2026-10-28): THEO-1E bought 40 GRAVITON_EMITTERS at about 33.8k a unit, 1.35M in one trip, about 40% of the wallet, for a
 * route that sold into a market taking lots of 18. A rival sold into that market first and the cargo went for 765k. Contract buys already carry
 * a cash-share brake (contractBuyGuard.ts); ordinary trades had none, so one wrong estimate could take whatever the wallet held.
 *
 * One rule: a trip may spend at most `cashSharePct` percent of the spendable cash it started with. Below `freeBelow` credits there is no
 * limit, so a small wallet (the opening, 175k) is never throttled. 0 for the percentage switches the rule off.
 *
 * Pure: no I/O, no clock.
 */
export interface TradeBuyPolicy {
  /** Most of the spendable cash one trip's purchases may use, in percent. 0 = off. */
  cashSharePct: number;
  /** A trip may always spend up to this many credits, whatever the share works out to. */
  freeBelow: number;
}

export const NO_TRADE_BUY_LIMIT: TradeBuyPolicy = { cashSharePct: 0, freeBelow: 0 };

export interface TripBudget {
  /** Most credits the trip may spend; Infinity when nothing limits it. */
  budget: number;
  /** One line for the log. */
  reason: string;
}

const rounded = (n: number) => Math.round(n).toLocaleString("en-US");

export function tripBuyBudget(spendable: number, p: TradeBuyPolicy): TripBudget {
  if (!(p.cashSharePct > 0) || !(spendable > 0)) return { budget: Number.POSITIVE_INFINITY, reason: "no limit" };
  const share = (spendable * p.cashSharePct) / 100;
  const budget = Math.max(share, Math.max(0, p.freeBelow));
  if (budget >= spendable) return { budget: Number.POSITIVE_INFINITY, reason: "no limit" };
  return { budget, reason: `a trip may use ${rounded(budget)}c: ${p.cashSharePct}% of the ${rounded(spendable)}c spendable (never less than ${rounded(p.freeBelow)}c)` };
}
