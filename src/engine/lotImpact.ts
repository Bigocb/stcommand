/**
 * How far one lot of our own trading moves a market's price, measured from our own fills.
 *
 * The route model charges a flat PRICE_IMPACT_PER_LOT (4.5%, measured on FAB_MATS 2026-10-05). Markets differ a lot.
 * 2026-10-23, THEOREM-38, NEURAL_CHIPS in 15-unit lots: buying 80 units lifted the ask 21,677c -> 30,228c (about +6.8% a
 * lot, growing with every lot) and selling 75 units sank the bid 31,832c -> 19,464c (about -9.3% a lot). The route read a
 * 47% margin and the trip made about +107k with 50k more still to lose on the five units left over. A flat 4.5% would have
 * taken roughly half as many lots as the market could stand.
 *
 * Pure: the caller hands over a run of our lots at one market (units and price each, in order) and asks what a lot
 * moves the price by, or how many units a trip should take. `maxFactor` 0 (the default policy) switches the whole thing
 * off: every answer is the flat default, so callers behave exactly as before.
 */

export interface Lot {
  units: number;
  price: number;
  /** ms */
  at: number;
}

export type Side = "buy" | "sell";

export interface ImpactPolicy {
  /** The most a learned impact may be, as a multiple of the default; 0 = off (always the default). */
  maxFactor: number;
  /** Fewer than this many lots in a run say nothing about the slope. */
  minLots: number;
  /** A run is the lots at one market with gaps no longer than this. */
  runGapMs: number;
  /** A measurement older than this is forgotten. */
  maxAgeMs: number;
  /** Runs averaged together. */
  keepRuns: number;
}

export const DEFAULT_IMPACT_POLICY: ImpactPolicy = { maxFactor: 0, minLots: 3, runGapMs: 120_000, maxAgeMs: 6 * 3_600_000, keepRuns: 3 };

export interface Measured {
  /** Fraction of price per full lot, in the direction of our trade (always positive when the price moved against us). */
  perLot: number;
  lots: number;
}

/**
 * The per-lot move of one run: the first lot's price against the last lot's, over the lots of our units that went in
 * before the last one (the last lot's own price is the price after everything before it). Geometric, so a price that
 * moved 30% over 5 lots reads 6.8%, not 6%. `tradeVolume` is the market's lot size; undefined takes the biggest lot seen.
 */
export function measureRun(side: Side, lots: readonly Lot[], tradeVolume?: number): Measured | undefined {
  const usable = lots.filter((l) => l.units > 0 && l.price > 0);
  if (usable.length < 2) return undefined;
  const tv = tradeVolume && tradeVolume > 0 ? tradeVolume : Math.max(...usable.map((l) => l.units));
  const before = usable.slice(0, -1).reduce((s, l) => s + l.units, 0);
  const lotsMoved = before / tv;
  if (lotsMoved < 1) return undefined;
  const ratio = usable[usable.length - 1]!.price / usable[0]!.price;
  const perLot = side === "buy" ? Math.pow(ratio, 1 / lotsMoved) - 1 : 1 - Math.pow(ratio, 1 / lotsMoved);
  return { perLot, lots: usable.length };
}

/** Split a time-ordered list of lots into runs (a gap longer than `gapMs` starts a new one). */
export function splitRuns(lots: readonly Lot[], gapMs: number): Lot[][] {
  const runs: Lot[][] = [];
  for (const l of [...lots].sort((a, b) => a.at - b.at)) {
    const last = runs[runs.length - 1];
    if (last && l.at - last[last.length - 1]!.at <= gapMs) last.push(l);
    else runs.push([l]);
  }
  return runs;
}

export interface Learned {
  /** What to plan with: the average of the recent runs, clamped to [default, default x maxFactor]. */
  perLot: number;
  runs: number;
  /** One line for the log; undefined when it is just the default. */
  reason?: string;
}

/**
 * The per-lot impact to plan with at one (market, side), from the lots we recorded there. Never below the default:
 * a run that happened to move the price less is as likely a market that was refilling as one that is deeper.
 */
export function learnImpact(side: Side, lots: readonly Lot[], now: number, fallback: number, policy: ImpactPolicy, tradeVolume?: number): Learned {
  const off: Learned = { perLot: fallback, runs: 0 };
  if (!(policy.maxFactor > 0)) return off;
  const recent = lots.filter((l) => l.at >= now - policy.maxAgeMs);
  const measures = splitRuns(recent, policy.runGapMs)
    .filter((r) => r.length >= policy.minLots)
    .map((r) => measureRun(side, r, tradeVolume))
    .filter((m): m is Measured => m !== undefined && Number.isFinite(m.perLot))
    .slice(-policy.keepRuns);
  if (!measures.length) return off;
  const mean = measures.reduce((s, m) => s + m.perLot, 0) / measures.length;
  const perLot = Math.min(fallback * policy.maxFactor, Math.max(fallback, mean));
  if (perLot <= fallback) return { perLot: fallback, runs: measures.length };
  return {
    perLot,
    runs: measures.length,
    reason: `our last ${measures.length} run(s) moved the ${side === "buy" ? "ask" : "bid"} ${(mean * 100).toFixed(1)}% a lot, planning on ${(perLot * 100).toFixed(1)}% not ${(fallback * 100).toFixed(1)}%`,
  };
}

export interface SizeInput {
  buyPrice: number;
  sellPrice: number;
  buyVolume: number;
  sellVolume: number;
  buyImpact: number;
  sellImpact: number;
}

/**
 * Units that earn the most before our own price impact eats the spread. With the average price sitting half way along
 * the move (routeEconomics.slippageCredits), profit(u) = margin x u - k x u^2 / 2 where
 * k = buyPrice x buyImpact / buyVolume + sellPrice x sellImpact / sellVolume, so profit peaks at u = margin / k.
 * Returns undefined when there is no spread or no usable volume.
 */
export function bestUnits(i: SizeInput): number | undefined {
  const margin = i.sellPrice - i.buyPrice;
  if (!(margin > 0) || !(i.buyVolume > 0) || !(i.sellVolume > 0)) return undefined;
  const k = (i.buyPrice * i.buyImpact) / i.buyVolume + (i.sellPrice * i.sellImpact) / i.sellVolume;
  if (!(k > 0)) return undefined;
  return Math.floor(margin / k);
}

/**
 * The trip size to plan with: `units` cut to bestUnits(), but never below one lot of the smaller market (a trip of a
 * few units is not worth flying) and never above `units`. With the policy off it is `units`.
 */
export function sizeForImpact(units: number, i: SizeInput, policy: ImpactPolicy): { units: number; reason?: string } {
  if (!(policy.maxFactor > 0)) return { units };
  const best = bestUnits(i);
  if (best === undefined) return { units };
  const floor = Math.min(i.buyVolume, i.sellVolume);
  const capped = Math.max(floor, best);
  if (capped >= units) return { units };
  return { units: capped, reason: `price impact peaks the trip at ${best} units, not ${units}` };
}
