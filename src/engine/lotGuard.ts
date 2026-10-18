/**
 * Whether the next lot of a sale may go. Pure: the caller reads the market and passes what it saw.
 *
 * A market's price falls with every lot sold into it, and on a thin market it falls a lot: VIRAL_AGENTS at X1-QD90-A1
 * (2026-10-18, THEOREM-64) paid 27,294c for the first 18 units and 20,428c for the next 18, a quarter less, against a floor of
 * about 26,460c (cost 31,127c, 15% allowed). The old guard looked at the price the lot it had JUST sold got, which is
 * the price before that lot's own impact, so it only ever stopped a pass after the damaging lot had gone: 192,587c lost on
 * one lot, twice in 33 minutes (262k a pass). What the next lot will fetch is the market's price NOW, so read it and judge that.
 */
export interface LotGuardInput {
  /** The lowest unit price this lot may sell at (cost basis less the allowed loss). */
  floor: number;
  /** The market's sell price read just now, or undefined when the read failed. */
  quote: number | undefined;
  /** What the lot just sold fetched per unit, and the one before it (when there was one). */
  lastPrice: number;
  prevPrice?: number;
}
export interface LotGuardDecision { ok: boolean; expected: number; reason: string }

/** When the market could not be read, assume the drop of the last lot repeats (or, with no earlier lot to compare, a quarter). */
export const UNKNOWN_DROP = 0.75;

export function nextLotDecision(i: LotGuardInput): LotGuardDecision {
  const guess = i.prevPrice && i.prevPrice > 0 ? i.lastPrice * Math.min(1, i.lastPrice / i.prevPrice) : i.lastPrice * UNKNOWN_DROP;
  const expected = i.quote !== undefined && i.quote > 0 ? i.quote : guess;
  const source = i.quote !== undefined && i.quote > 0 ? "live quote" : "estimate (market unreadable)";
  if (expected >= i.floor) return { ok: true, expected, reason: `next lot expected at ${Math.round(expected)}c (${source}), floor ${Math.round(i.floor)}c` };
  return { ok: false, expected, reason: `next lot would fetch ${Math.round(expected)}c (${source}), below the floor ${Math.round(i.floor)}c` };
}
