/**
 * Buy-side guards: judge a buy by what the destination actually pays, before the first lot and between lots.
 *
 * 2026-10-18, THEOREM-5 ran MEDICINE E52 > G58 four times in six minutes, lots of 20. Its own buying walked the ask
 * 3409 -> 3626 -> 3894 -> 4223 -> 4628 -> 5126 and its own selling walked the sink's bid down behind it: 4213, 4062,
 * 4746, 4569, 4549. Rounds one and two cleared their planned margin; round three bought at 4628 into a sink paying
 * 4549 and the ship ended holding 20 units at a cost of 4877 against a bid of 4327. MEDICINE at E52 takes a median of
 * 124 minutes to recover, so nothing was going to come back before the next round.
 *
 * Both old checks looked only at the route's PLANNED sell price: the live pre-buy check compared the live ask with a
 * snapshot up to half an hour old and never read the destination at all, and the between-lot stop ignored the fact that
 * the lots already bought are sold into that sink first and push its price down. These two functions make the
 * destination's live bid the thing that is judged, with the expected impact of our own lots allowed for on both ends.
 *
 * Pure: the caller reads the markets and passes what it saw. `impactPerLot` 0 or less switches both off.
 */

export interface BuyGuardPolicy {
  /** Expected price move per lot, as a fraction (the clause's percent / 100). 0 or less = guards off. */
  impactPerLot: number;
}
export interface GuardDecision { ok: boolean; reason: string }

/** Before the first lot of a trip. */
export interface SinkCheckInput {
  liveBuy: number;                 // the buy market's ask read just now
  liveSink: number | undefined;    // the destination's bid read just now; undefined when the read failed
  lots: number;                    // lots this trip plans to buy
  marginFloor: number;             // already effective: effectiveMarginFloor(flatFloor, liveBuy)
  policy: BuyGuardPolicy;
}

/**
 * Judge the whole planned trip by the destination's bid now, with our own buying moving the ask up and our own selling
 * moving the bid down over the lots the trip intends to run. A destination we could not read is not judged: that is
 * today's behaviour, and refusing on a failed read would stop trading on the first flaky request.
 */
export function sinkCheck(i: SinkCheckInput): GuardDecision {
  if (!(i.policy.impactPerLot > 0)) return { ok: true, reason: "guard off" };
  if (i.liveSink === undefined) return { ok: true, reason: "destination bid unreadable: not judged" };
  const n = Math.max(1, Math.floor(i.lots));
  // The average unit sits in the middle of the trip's lots: lot k of n moves the price by k impact steps, so the mean
  // is (n-1)/2 steps. One lot therefore takes no discount at all.
  const half = (n - 1) / 2;
  const avgBuy = i.liveBuy * (1 + i.policy.impactPerLot * half);
  const avgSell = i.liveSink * (1 - i.policy.impactPerLot * half);
  const margin = avgSell - avgBuy;
  if (margin < i.marginFloor) {
    return {
      ok: false,
      reason: `destination pays ${Math.round(i.liveSink)}c against an ask of ${Math.round(i.liveBuy)}c: expected margin ${Math.round(margin)}c over ${n} lot(s) is under the floor ${Math.round(i.marginFloor)}c`,
    };
  }
  return { ok: true, reason: `expected margin ${Math.round(margin)}c over ${n} lot(s), floor ${Math.round(i.marginFloor)}c` };
}

export interface ShrunkDecision extends GuardDecision {
  /** Lots the trip may buy: the planned number when it passes, fewer when only a smaller trip does, 0 when even one lot fails. */
  lots: number;
}

/**
 * sinkCheck() for the whole plan, and when that fails, for the largest smaller plan that passes. A trip planned at 8 lots
 * (the per-trip lot cap was raised to 8 for the big hulls) refused outright on 2026-10-29 when its average margin over 8
 * lots was 0c although three lots earned well: THEO-AB and THEO-EE, the 490-unit freighters, each flew to a buy market,
 * were turned away at the dock and marked the route dead, while the same buy at three lots would have paid. Refuse only
 * when a single lot fails. Pure.
 */
export function sinkCheckShrunk(i: SinkCheckInput): ShrunkDecision {
  const planned = Math.max(1, Math.floor(i.lots));
  for (let n = planned; n >= 1; n--) {
    const v = sinkCheck({ ...i, lots: n });
    if (v.ok) return { ok: true, lots: n, reason: n === planned ? v.reason : `trip cut from ${planned} to ${n} lot(s): ${v.reason}` };
  }
  return { ...sinkCheck({ ...i, lots: 1 }), ok: false, lots: 0 };
}

/** After each lot, before the next. */
export interface NextBuyLotInput {
  lotsBought: number;              // lots already bought in this trip (>= 1)
  lastPrice: number;               // per-unit price the lot just bought was paid at (the price BEFORE that lot's own impact)
  prevPrice?: number;              // per-unit price of the lot before that, when there was one
  liveSink: number | undefined;    // the same live destination bid read for sinkCheck (not read again)
  fallbackSink: number;            // the planned sell price, used only when liveSink is undefined
  marginFloor: number;             // effective, as above, computed on lastPrice
  policy: BuyGuardPolicy;
}

/**
 * Judge the next lot by the sink's bid AFTER the lots already held are sold into it. The next ask is estimated from how
 * much the last lot actually moved the price when there is a lot before it to compare (markets move in steps, not by the
 * policy percentage), and from the policy percentage for the first lot of the trip.
 */
export function nextBuyLotDecision(i: NextBuyLotInput): GuardDecision {
  if (!(i.policy.impactPerLot > 0)) return { ok: true, reason: "guard off" };
  const growth = i.prevPrice !== undefined && i.prevPrice > 0 ? Math.max(1, i.lastPrice / i.prevPrice) : 1 + i.policy.impactPerLot;
  const nextAsk = i.lastPrice * growth;
  // With no live bid the planned sell price stands in and takes no impact discount: that is exactly today's rule.
  const sell = i.liveSink === undefined ? i.fallbackSink : i.liveSink * (1 - i.policy.impactPerLot * i.lotsBought);
  const margin = sell - nextAsk;
  if (margin < i.marginFloor) {
    return {
      ok: false,
      reason: `next lot would cost about ${Math.round(nextAsk)}c against about ${Math.round(sell)}c at the destination after the ${i.lotsBought} lot(s) held: margin ${Math.round(margin)}c under the floor ${Math.round(i.marginFloor)}c`,
    };
  }
  return { ok: true, reason: `next lot about ${Math.round(nextAsk)}c, destination about ${Math.round(sell)}c, margin ${Math.round(margin)}c` };
}
