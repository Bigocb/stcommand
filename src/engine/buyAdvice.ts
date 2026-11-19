/**
 * The buy-ship warning (docs/economy-alerts-plan.md §2, docs/lessons-learned.md "the domino week").
 *
 * 2026-11-17 22:11: a heavy freighter (2,303,936c) was bought with about 2.93M in the wallet and the first heavy (19:24) not yet
 * paid back. The hull earned well; the wallet did not survive it (625k left, 95k by 01:37), because a heavy's load costs 300-400k.
 * Every manual buy bypasses the doctrine thresholds, so the cash rules were held by hand. This module checks a purchase against
 * them and says what it would break. It WARNS ONLY: the operator decides, and `ok` false never blocks a buy anywhere.
 *
 * Pure: no I/O, no clock. Rules are doctrine values (clause buyAdvice and the buyAdvice* clauses); rules off = no warnings.
 */

import { fmtCredits, type EconomyFinding } from "./economyHealth.js";

export interface BuyRules {
  on: boolean;
  /** Working capital a big hull needs to load fully. */
  bigHullLoad: number;
  /** Working capital each other trader needs. */
  traderReserve: number;
  /** Wallet before the buy needed for any hull. */
  anyHullLine: number;
  /** Wallet before the buy needed for a big hull. */
  bigHullLine: number;
  /** A hull with more cargo than this is a big hull. */
  bigHullCargo: number;
  /** The last big hull must have paid back its price in matched profit if it was bought within this many hours. */
  paybackHours: number;
  /** Cargo value in holds (in transit) a big hull purchase wants on top of the wallet line. 0 = not checked. Operator 2026-11-19:
   *  "3M with no cargo in transit is a lot different than 3M with 1.5M in cargo". */
  bigHullHolds: number;
}

export const DEFAULT_BUY_RULES: BuyRules = {
  on: true,
  bigHullLoad: 400_000,
  traderReserve: 100_000,
  anyHullLine: 3_000_000,
  bigHullLine: 10_000_000,
  bigHullCargo: 80,
  paybackHours: 6,
  bigHullHolds: 0,
};

export const BUY_RULES_OFF: BuyRules = { ...DEFAULT_BUY_RULES, on: false };

export interface BuyAdviceInput {
  price: number;
  /** Cargo capacity of the hull being bought (0 for a probe). */
  cargo: number;
  wallet: number;
  /** Estimated value of every loaded hold. */
  holds: number;
  /** Trading hulls now, big ones included. */
  traders: number;
  /** Big hulls (cargo over bigHullCargo) now. */
  bigHulls: number;
  /** The most recent big hull bought this week, with its matched profit since. */
  lastBigHullBuy?: { ship: string; price: number; at: number; profitSince: number };
  now?: number;
  /** Current economy findings; any at level "bad" is a warning. */
  economyFindings?: readonly Pick<EconomyFinding, "id" | "level" | "line">[];
  /** The operator's escape clause: cash flat or falling for ~2 h with traders idle allows a buy to restart growth. */
  escape?: { cashFlatOrFalling2h: boolean; idleTraders: number };
  rules: BuyRules;
}

export interface BuyAdvice {
  /** True when nothing is warned about. Never used to block a purchase. */
  ok: boolean;
  warnings: string[];
  /** Notes that are not warnings (the escape clause). */
  notes: string[];
  /** Working-capital floor after the buy. */
  floor: number;
  walletAfter: number;
  bigHull: boolean;
}

/** big hulls x a full load + other traders x their reserve. */
export function workingCapitalFloor(bigHulls: number, otherTraders: number, rules: Pick<BuyRules, "bigHullLoad" | "traderReserve">): number {
  return Math.max(0, bigHulls) * rules.bigHullLoad + Math.max(0, otherTraders) * rules.traderReserve;
}

export function buyAdvice(i: BuyAdviceInput): BuyAdvice {
  const r = i.rules;
  const bigHull = i.cargo > r.bigHullCargo;
  const walletAfter = i.wallet - i.price;
  if (!r.on) return { ok: true, warnings: [], notes: [], floor: 0, walletAfter, bigHull };
  const tradingHull = i.cargo > 0;
  const bigAfter = i.bigHulls + (bigHull ? 1 : 0);
  const othersAfter = Math.max(0, i.traders - i.bigHulls) + (tradingHull && !bigHull ? 1 : 0);
  const floor = workingCapitalFloor(bigAfter, othersAfter, r);
  const warnings: string[] = [];
  const notes: string[] = [];

  if (walletAfter < floor) {
    warnings.push(`Wallet after the buy ${fmtCredits(walletAfter)} is under the working-capital floor ${fmtCredits(floor)} (${bigAfter} big hull${bigAfter === 1 ? "" : "s"} x ${fmtCredits(r.bigHullLoad)} + ${othersAfter} other trader${othersAfter === 1 ? "" : "s"} x ${fmtCredits(r.traderReserve)}): traders may not be able to load fully.`);
  }
  if (bigHull && i.wallet < r.bigHullLine) {
    const alsoAny = i.wallet < r.anyHullLine ? ` (and the ${fmtCredits(r.anyHullLine)} line for any hull)` : "";
    warnings.push(`Wallet ${fmtCredits(i.wallet)} is under the ${fmtCredits(r.bigHullLine)} line for a hull over ${r.bigHullCargo} cargo${alsoAny}.`);
  } else if (i.wallet < r.anyHullLine) {
    warnings.push(`Wallet ${fmtCredits(i.wallet)} is under the ${fmtCredits(r.anyHullLine)} line for any hull.`);
  }
  if (bigHull && r.bigHullHolds > 0 && i.holds < r.bigHullHolds) {
    warnings.push(`Holds ${fmtCredits(i.holds)} are under the ${fmtCredits(r.bigHullHolds)} of cargo in transit a big hull buy wants on top of the wallet line (wallet + holds ${fmtCredits(i.wallet + i.holds)}).`);
  }
  const last = i.lastBigHullBuy;
  if (bigHull && last && i.now !== undefined) {
    const ageH = (i.now - last.at) / 3_600_000;
    if (ageH >= 0 && ageH < r.paybackHours && last.profitSince < last.price) {
      warnings.push(`${last.ship}, the last big hull (${fmtCredits(last.price)}, ${ageH.toFixed(1)} h ago), has made ${fmtCredits(last.profitSince)} matched profit: not paid back yet (${r.paybackHours} h rule).`);
    }
  }
  for (const f of i.economyFindings ?? []) {
    if (f.level === "bad") warnings.push(`Economy: ${f.line}`);
  }
  if (i.escape?.cashFlatOrFalling2h && i.escape.idleTraders > 0) {
    notes.push(`Escape clause: cash has been flat or falling for 2 h and ${i.escape.idleTraders} trader${i.escape.idleTraders === 1 ? " is" : "s are"} idle. The operator's rule allows a hull to restart growth.`);
  }
  return { ok: warnings.length === 0, warnings, notes, floor, walletAfter, bigHull };
}

/** The doctrine-backed rules. */
export function buyRulesFrom(d: { value(key: string, whenOff?: number): number; isEnabledOr(key: string, fallback: boolean): boolean }): BuyRules {
  if (!d.isEnabledOr("buyAdvice", true)) return BUY_RULES_OFF;
  const v = (key: string, def: number) => (d.isEnabledOr(key, true) ? d.value(key, def) : def);
  return {
    on: true,
    bigHullLoad: v("buyAdviceBigHullLoad", DEFAULT_BUY_RULES.bigHullLoad),
    traderReserve: v("buyAdviceTraderReserve", DEFAULT_BUY_RULES.traderReserve),
    anyHullLine: v("buyAdviceAnyHullLine", DEFAULT_BUY_RULES.anyHullLine),
    bigHullLine: v("buyAdviceBigHullLine", DEFAULT_BUY_RULES.bigHullLine),
    bigHullCargo: v("buyAdviceBigHullCargo", DEFAULT_BUY_RULES.bigHullCargo),
    paybackHours: v("buyAdvicePaybackHours", DEFAULT_BUY_RULES.paybackHours),
    bigHullHolds: d.isEnabledOr("buyAdviceBigHullHolds", false) ? d.value("buyAdviceBigHullHolds", 0) : 0,
  };
}

/**
 * Cargo capacity of a hull for sale. Shipyard inventory rows carry cargoCapacity 0, so the buy warning took a heavy freighter (225) for
 * a 0-cargo hull: on 2026-11-19 THEO-BD's purchase showed no big-hull warning and a floor counted with one big hull. The capacity is the
 * sum of the hull's cargo-hold modules when the field is 0. Pure.
 */
export function hullCargo(offer: { cargoCapacity?: number | null; modules?: readonly { symbol: string; capacity?: number }[] | null } | undefined): number {
  if (!offer) return 0;
  if ((offer.cargoCapacity ?? 0) > 0) return offer.cargoCapacity as number;
  return (offer.modules ?? []).filter((m) => m.symbol.includes("CARGO_HOLD")).reduce((n, m) => n + (m.capacity ?? 0), 0);
}
