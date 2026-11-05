/**
 * Thin markets: a dear good whose market takes only a few units a trade, where our own selling crashes the price.
 *
 * The route model sizes a trip on a flat 4.5% price move per lot (PRICE_IMPACT_PER_LOT, measured on FAB_MATS at a 20-unit
 * lot), and the learned impact (lotImpact.ts) only knows a market after we have sold into it, capped at 3x the default.
 * Dear goods in small lots move far more, so the first trip into one is always sized as if the market were deep:
 *   - 2026-10-30 THEO-EE: 90 NOVEL_LIFEFORMS (about 1.06M) sold at X1-ZV54-A1 from 8,085 down to 1 a unit, about -729k.
 *   - 2026-11-05 THEO-13A: 90 VIRAL_AGENTS (cost 26,138 each) into X1-TN61-A1 at 18 a trade: 31,027, 25,902, 19,592,
 *     11,824 (a 16%, 24% and 40% fall per lot), -292k net and 18 left that the market then bid 2,260 for.
 *   - Same day, MICRO_FUSION_GENERATORS at X1-SR93-A1 (18 a trade): 8-10% a lot. NEURAL_CHIPS 2026-10-23 (15 a trade): 9%.
 *
 * The rule: a sell market is thin when its trade volume is at most `maxVolume` and the good sells for at least `minPrice`.
 * A trip into a thin market is planned with at least `sellImpact` price move per lot and carries at most `maxLots` of the
 * market's lots. Other markets are untouched.
 *
 * Pure: numbers in, verdict and a one-line reason out. Policy is data, backed by the doctrine clauses thinMarketSellImpactPct
 * and thinMarketMaxLots; with the clause off nothing changes.
 */

export interface ThinPolicy {
  enabled: boolean;
  /** A sell market trading at most this many units a transaction can be thin. */
  maxVolume: number;
  /** ... when the good sells for at least this much. */
  minPrice: number;
  /** Price move per lot to plan with at a thin market (a fraction, 0.15 = 15%). */
  sellImpact: number;
  /** The most lots of the sell market's size one trip may carry there. */
  maxLots: number;
}

export const DEFAULT_THIN_POLICY: ThinPolicy = { enabled: false, maxVolume: 20, minPrice: 10_000, sellImpact: 0.15, maxLots: 3 };

export interface ThinVerdict {
  thin: boolean;
  /** The sell impact to plan with: `base` unless the market is thin. */
  sellImpact: number;
  /** The most units a trip should carry to this market (Infinity when not thin). */
  maxUnits: number;
  reason?: string;
}

export function thinMarket(sell: { volume: number; price: number }, base: number, policy: ThinPolicy): ThinVerdict {
  const plain: ThinVerdict = { thin: false, sellImpact: base, maxUnits: Infinity };
  if (!policy.enabled || !(sell.volume > 0) || sell.volume > policy.maxVolume || sell.price < policy.minPrice) return plain;
  const maxUnits = Math.max(1, Math.floor(policy.maxLots * sell.volume));
  const sellImpact = Math.max(base, policy.sellImpact);
  return {
    thin: true,
    sellImpact,
    maxUnits,
    reason: `thin sell market (${sell.volume} a trade at ${Math.round(sell.price)}): planning ${(sellImpact * 100).toFixed(0)}% a lot, at most ${maxUnits} units`,
  };
}
