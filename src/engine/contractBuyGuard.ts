/**
 * Whether a contract purchase is worth making at this price, and how much of the wallet one purchase may take.
 *
 * Why it exists (2026-10-25): a trader on contract duty bought 20 FOOD at 4,666c each (93k, nearly all the cash) for a contract worth
 * about 2,800c a unit, because the market it stood in was the only FOOD price known at that moment. The old guard compared the live
 * price with the dispatcher's own snapshot (which was the same inflated price), never with what the contract pays. Cash then sat at the
 * floor, trading stalled, and a contract that pays on completion could not be finished (it needed 56k more).
 *
 * Two rules, both switchable and both ignored when the facts they need are missing:
 *   1. Price: refuse a unit that costs more than `priceGuardPct` percent of what the contract still pays per unit it still needs.
 *      (Payment still owed divided by units still needed: an advance already banked is gone either way.)
 *   2. Cash share: one purchase may spend at most `cashSharePct` percent of the spendable cash, so a bad price estimate cannot take it all.
 *
 * Pure: no I/O, no clock. 0 for a percentage switches that rule off, and with both off this changes nothing.
 */

export interface ContractBuyPolicy {
  /** Highest price, as a percent of the contract's pay per unit still needed. 0 = off. */
  priceGuardPct: number;
  /** Most of the spendable cash one purchase may use, in percent. 0 = off. */
  cashSharePct: number;
}

export const NO_CONTRACT_BUY_GUARD: ContractBuyPolicy = { priceGuardPct: 0, cashSharePct: 0 };

export interface ContractBuyFacts {
  buyPrice: number;
  /** Units the contracts that want this good still need. */
  remainingUnits: number;
  /** What those contracts still pay on completion (not counting an advance already received). */
  remainingPayout: number;
  /** Cash the ship may spend now (above the cash floor). */
  spendable: number;
}

export interface ContractBuyVerdict {
  blocked: boolean;
  /** Most units this purchase may take; Infinity when nothing limits it. */
  maxUnits: number;
  /** One line for the log. */
  reason: string;
}

const rounded = (n: number) => Math.round(n).toLocaleString("en-US");

export function contractBuyVerdict(f: ContractBuyFacts, p: ContractBuyPolicy): ContractBuyVerdict {
  if (p.priceGuardPct > 0 && f.remainingUnits > 0 && f.remainingPayout > 0) {
    const perUnit = f.remainingPayout / f.remainingUnits;
    const ceiling = (perUnit * p.priceGuardPct) / 100;
    if (f.buyPrice > ceiling) {
      return {
        blocked: true,
        maxUnits: 0,
        reason: `${rounded(f.buyPrice)}c a unit is over the ceiling of ${rounded(ceiling)}c (the contract still pays ${rounded(perUnit)}c a unit, guard ${p.priceGuardPct}%)`,
      };
    }
  }
  if (p.cashSharePct > 0 && f.buyPrice > 0) {
    // At least one unit when one is affordable at all: the share is a brake, not a way to make a purchase impossible.
    const share = Math.floor((f.spendable * p.cashSharePct) / 100 / f.buyPrice);
    const maxUnits = f.spendable >= f.buyPrice ? Math.max(1, share) : 0;
    return { blocked: false, maxUnits, reason: `at most ${maxUnits} unit(s): ${p.cashSharePct}% of the ${rounded(f.spendable)}c spendable` };
  }
  return { blocked: false, maxUnits: Number.POSITIVE_INFINITY, reason: "no limit" };
}
