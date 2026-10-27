/**
 * How good a starting system is for the weekly gate, from what anyone can read about it right after registering. Pure.
 *
 * The gate needs 1,600 FAB_MATS and 400 ADVANCED_CIRCUITRY. A home system with ONE FAB_MATS producer saturates quickly: past
 * the producer's refill rate the price goes exponential (THEO, 2026-10-26: 1,200 -> 13,500 in a day). Players who finish in under
 * 18 hours almost always have two sources; the operator's own best week (34 h, X1-YM69) had a second one one gate away. So the
 * score is mostly "how many FAB_MATS sources, and can the chain behind them be fed from the same system".
 *
 * Market import/export lists are public without a ship; prices and supply are not, so nothing here needs a ship.
 */

export interface StartMarket {
  symbol: string;
  imports: readonly string[];
  exports: readonly string[];
  exchange: readonly string[];
}

export interface StartFacts {
  agentSymbol: string;
  headquarters: string;
  system: string;
  markets: readonly StartMarket[];
  gate?: { waypoint: string; complete: boolean; materials: readonly { tradeSymbol: string; required: number; fulfilled: number }[] };
}

export interface StartPolicy {
  /** Points for each FAB_MATS source beyond the first, and the penalty for having none at home. */
  extraFabSource: number;
  noFabSource: number;
  /** Circuitry: have a producer at home (points) or not (penalty). */
  circuitrySource: number;
  noCircuitrySource: number;
  /** Each raw input of the two producers found in the system (iron, quartz sand, electronics, microprocessors), and missing. */
  inputPresent: number;
  inputMissing: number;
  /** Per marketplace (capped) and per distinct good traded (capped): more markets, more routes while the gate is closed. */
  perMarket: number;
  marketCap: number;
  perGood: number;
  goodCap: number;
}

export const DEFAULT_START_POLICY: StartPolicy = {
  extraFabSource: 150,
  noFabSource: -200,
  circuitrySource: 40,
  noCircuitrySource: -100,
  inputPresent: 12,
  inputMissing: -30,
  perMarket: 2,
  marketCap: 40,
  perGood: 0.5,
  goodCap: 30,
};

export const FAB_INPUTS = ["IRON", "QUARTZ_SAND"] as const;
export const CIRCUITRY_INPUTS = ["ELECTRONICS", "MICROPROCESSORS"] as const;

export interface StartScore {
  score: number;
  fabSources: string[];
  circuitrySources: string[];
  marketCount: number;
  distinctGoods: number;
  missingInputs: string[];
  reasons: string[];
}

const sells = (m: StartMarket, good: string): boolean => m.exports.includes(good) || m.exchange.includes(good);

export function scoreStart(facts: StartFacts, policy: StartPolicy = DEFAULT_START_POLICY): StartScore {
  const reasons: string[] = [];
  const fabSources = facts.markets.filter((m) => sells(m, "FAB_MATS")).map((m) => m.symbol);
  const circuitrySources = facts.markets.filter((m) => sells(m, "ADVANCED_CIRCUITRY")).map((m) => m.symbol);
  let score = 0;

  if (fabSources.length === 0) {
    score += policy.noFabSource;
    reasons.push("no FAB_MATS source in the home system: the gate would depend on another system");
  } else if (fabSources.length === 1) {
    reasons.push(`one FAB_MATS source (${fabSources[0]}): it saturates past its refill rate`);
  } else {
    score += policy.extraFabSource * (fabSources.length - 1);
    reasons.push(`${fabSources.length} FAB_MATS sources (${fabSources.join(", ")}): demand splits, the price stays low longer`);
  }

  if (circuitrySources.length === 0) {
    score += policy.noCircuitrySource;
    reasons.push("no ADVANCED_CIRCUITRY source at home");
  } else {
    score += policy.circuitrySource;
    reasons.push(`circuitry from ${circuitrySources.join(", ")}`);
  }

  const missingInputs: string[] = [];
  for (const good of [...FAB_INPUTS, ...CIRCUITRY_INPUTS]) {
    if (facts.markets.some((m) => sells(m, good))) score += policy.inputPresent;
    else {
      score += policy.inputMissing;
      missingInputs.push(good);
    }
  }
  if (missingInputs.length) reasons.push(`not sold anywhere at home: ${missingInputs.join(", ")}`);

  const goods = new Set<string>();
  for (const m of facts.markets) for (const g of [...m.imports, ...m.exports, ...m.exchange]) goods.add(g);
  score += Math.min(policy.marketCap, facts.markets.length * policy.perMarket);
  score += Math.min(policy.goodCap, goods.size * policy.perGood);
  reasons.push(`${facts.markets.length} markets, ${goods.size} distinct goods`);

  return { score: Math.round(score), fabSources, circuitrySources, marketCount: facts.markets.length, distinctGoods: goods.size, missingInputs, reasons };
}
