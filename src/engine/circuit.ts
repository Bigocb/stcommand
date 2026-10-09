/**
 * Circuits: a committed two-leg trip, buy A -> sell B, then buy near B -> sell near A. See docs/backhaul-plan.md (v2).
 *
 * v1 (chain.ts) only credits a route for the best trip that can start where it sells, and the trader picks again from
 * scratch after the sale. A circuit goes one step further: the second leg must also END near where the first began, so
 * the ship is positioned to repeat the pair, and the dispatcher keeps the second leg for that ship (see
 * RouteDispatcher.circuits) instead of leaving it to be taken by someone else or re-ranked away.
 *
 * Pure: no I/O, no clock. Everything the dispatcher already knows (distances, what is already promised) comes in through
 * `CircuitContext`. Policy is data (`CircuitPolicy`); weight 0 is the off switch and reproduces today's picks exactly.
 * Same-system pairs only for now: cross-system legs pay jumps and need their own cost model (v3).
 */

import type { ChainCandidate } from "./chain.js";

export interface CircuitPolicy {
  /** Share (0..1) of the circuit's gain over the route's own score that is credited. 0 switches the feature off. */
  weight: number;
  /** Longest empty flight allowed between legs (sell -> next buy, and last sell -> first buy), in minutes. */
  horizonMinutes: number;
  /** Leg 2 is dropped when its score has fallen under this share of what was planned. */
  bailoutShare: number;
  /** A planned circuit is forgotten (and its second leg released) after this many minutes. */
  ttlMinutes: number;
  /** Leg 2 is dropped when the spendable cash would not buy at least this share of its planned load. */
  minCashShare: number;
  /**
   * How much of the empty flight from leg 2's sell market back to leg 1's buy market counts against the circuit (0..1).
   * 1 (today) wants a true loop: leg 2 must end near where leg 1 began. 0 only asks for two loaded legs back to back and
   * lets the ship pick again from wherever leg 2 ends, which admits many more pairs.
   */
  returnShare: number;
}

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = { weight: 0, horizonMinutes: 10, bailoutShare: 0.5, ttlMinutes: 60, minCashShare: 0.5, returnShare: 1 };

export interface CircuitContext {
  /** Straight-line distance between two waypoints in one system. */
  distanceBetween: (a: string, b: string) => number;
  /** True when this leg may not be used as a second leg (already assigned, reserved by another circuit, refused...). */
  unavailable: (candidate: ChainCandidate) => boolean;
}

export interface Circuit {
  leg1: ChainCandidate;
  leg2: ChainCandidate;
  /**
   * The pair's score on the same scale as `ChainCandidate.profitPerTrip` (profit per reference trip time), over the
   * whole cycle A -> B -> C -> D -> A: both legs' profit divided by both legs' flying time plus the two empty hops.
   */
  rate: number;
  /** Seconds for one full cycle, including both empty hops. */
  cycleSeconds: number;
  /** Empty seconds between selling leg 1 and buying leg 2. */
  betweenSeconds: number;
  /** Empty seconds from selling leg 2 back to leg 1's buy market. */
  returnSeconds: number;
  explain: string;
}

/** What the dispatcher remembers about a circuit it has handed out, until leg 2 is served or the plan expires. */
export interface PlannedCircuit {
  leg2: { good: string; buyAt: string; sellAt: string };
  /** Leg 2's own score when planned, for the bail-out check. */
  leg2Score: number;
  /** When it was planned (epoch ms). */
  at: number;
  /** Set once leg 1's cargo has been sold; leg 2 is only served after that. */
  leg1Sold?: boolean;
}

const systemOf = (waypoint: string): string => waypoint.slice(0, waypoint.lastIndexOf("-"));

/** Identity of a leg across recomputes (work keys change with what else is on the board). */
export const legId = (leg: { good: string; buyAt: string; sellAt: string }): string => `${leg.good}|${leg.buyAt}|${leg.sellAt}`;

/**
 * The best second leg for `leg1`: starts within the horizon of leg 1's sell market, ends within the horizon of leg 1's
 * buy market, and sells a different good. Same system throughout. Best = highest cycle rate.
 */
export function bestCircuit(
  leg1: ChainCandidate,
  candidates: readonly ChainCandidate[],
  ctx: CircuitContext,
  policy: CircuitPolicy,
): Circuit | undefined {
  if (policy.weight <= 0) return undefined;
  if (leg1.profitPerTrip <= 0 || leg1.tripSeconds <= 0) return undefined;
  const system = leg1.buySystem;
  if (systemOf(leg1.sellAt) !== system) return undefined;
  const horizon = policy.horizonMinutes * 60;
  let best: Circuit | undefined;
  for (const c of candidates) {
    if (c.key === leg1.key || c.good === leg1.good) continue;
    if (c.profitPerTrip <= 0 || c.tripSeconds <= 0) continue;
    if (c.buySystem !== system || systemOf(c.sellAt) !== system) continue;
    if (ctx.unavailable(c)) continue;
    const betweenSeconds = ctx.distanceBetween(leg1.sellAt, c.buyAt) * c.secPerDist;
    const returnSeconds = ctx.distanceBetween(c.sellAt, leg1.buyAt) * leg1.secPerDist;
    if (!Number.isFinite(betweenSeconds) || !Number.isFinite(returnSeconds)) continue;
    if (betweenSeconds > horizon || (policy.returnShare > 0 && returnSeconds > horizon)) continue;
    // Each trip time is a round trip; half of it is one way (plus dock time). The pair's profit is the two scored rates
    // turned back into per-trip amounts (rate x trip / reference), divided by the cycle, so reference time cancels.
    const cycleSeconds = leg1.tripSeconds / 2 + c.tripSeconds / 2 + betweenSeconds + returnSeconds * policy.returnShare;
    const rate = (leg1.profitPerTrip * leg1.tripSeconds + c.profitPerTrip * c.tripSeconds) / cycleSeconds;
    if (!best || rate > best.rate) {
      best = {
        leg1, leg2: c, rate, cycleSeconds, betweenSeconds, returnSeconds,
        explain: `circuit rate ${Math.round(rate)} (then ${c.good}: buy ${c.buyAt}, sell ${c.sellAt}, ${Math.round(betweenSeconds)}s empty after the sale, ${Math.round(returnSeconds)}s back to ${leg1.buyAt})`,
      };
    }
  }
  return best;
}

/**
 * One line for the log saying why a route got no circuit: how many second legs were even candidates, how many passed each
 * distance test, and the best pair that did (with its rate against the route's own score), so the horizon and return share
 * can be tuned from what the dispatcher actually sees.
 */
export function circuitReport(
  leg1: ChainCandidate,
  candidates: readonly ChainCandidate[],
  ctx: CircuitContext,
  policy: CircuitPolicy,
  ownScore: number,
): string {
  const system = leg1.buySystem;
  const horizon = policy.horizonMinutes * 60;
  let sameSystem = 0, free = 0, nearSale = 0, nearStart = 0;
  for (const c of candidates) {
    if (c.key === leg1.key || c.good === leg1.good || c.profitPerTrip <= 0 || c.tripSeconds <= 0) continue;
    if (c.buySystem !== system || systemOf(c.sellAt) !== system) continue;
    sameSystem += 1;
    if (ctx.unavailable(c)) continue;
    free += 1;
    const between = ctx.distanceBetween(leg1.sellAt, c.buyAt) * c.secPerDist;
    const back = ctx.distanceBetween(c.sellAt, leg1.buyAt) * leg1.secPerDist;
    if (between <= horizon) nearSale += 1;
    if (between <= horizon && back <= horizon) nearStart += 1;
  }
  const best = bestCircuit(leg1, candidates, ctx, policy);
  const pairs = `${sameSystem} same-system legs, ${free} free, ${nearSale} start within ${policy.horizonMinutes}m of the sale, ${nearStart} also end within ${policy.horizonMinutes}m of the start`;
  if (!best) return `no circuit (${pairs})`;
  return `circuit not better than the route alone: best ${best.leg2.good} rate ${Math.round(best.rate)} vs route ${Math.round(ownScore)} (${Math.round(best.betweenSeconds)}s empty after the sale, ${Math.round(best.returnSeconds)}s back; ${pairs})`;
}

/**
 * The route's score once the circuit is credited. `base` is the route's own score as the dispatcher computed it (impact
 * and positioning already applied); `penalty` is the part of it that came off for extra buyers, charged to the circuit
 * too; `positioningSeconds` is the empty flight to leg 1's buy, discounted the way the dispatcher discounts a single
 * route. Only the part of the circuit above the route's own score is credited, scaled by the weight, so a circuit that
 * is no better than the route alone changes nothing, and weight 0 returns `base`.
 */
export function circuitScore(base: number, circuit: Circuit | undefined, positioningSeconds: number, penalty: number, policy: CircuitPolicy): number {
  if (!circuit || policy.weight <= 0) return base;
  const t = circuit.leg1.tripSeconds;
  const asCircuit = circuit.rate * (t / (t + Math.max(0, positioningSeconds))) - penalty;
  return asCircuit > base ? base + policy.weight * (asCircuit - base) : base;
}

export interface Leg2Verdict {
  ok: boolean;
  reason: string;
}

/**
 * Should the planned second leg still be flown? `nowScore` is its current score for this ship (undefined when it is no
 * longer on the board, reserved by someone else, unreachable or refused). `afford`, when the caller knows the wallet,
 * is the cash free to spend (above the cash floor, after the first leg's proceeds) and the cost of the planned load: a
 * leg that cash cannot buy at least `minCashShare` of would be flown nearly empty, so it is dropped instead.
 */
export function judgeLeg2(planned: PlannedCircuit, nowScore: number | undefined, policy: CircuitPolicy, afford?: { spendable: number; cost: number }): Leg2Verdict {
  if (nowScore === undefined) return { ok: false, reason: "no longer available" };
  if (nowScore <= 0) return { ok: false, reason: "no longer profitable" };
  if (nowScore < planned.leg2Score * policy.bailoutShare) {
    return { ok: false, reason: `score fell to ${Math.round(nowScore)} from ${Math.round(planned.leg2Score)} (under ${Math.round(policy.bailoutShare * 100)}%)` };
  }
  if (afford && afford.cost > 0 && afford.spendable < afford.cost * policy.minCashShare) {
    return { ok: false, reason: `cash: ${Math.round(afford.spendable)} spendable vs ${Math.round(afford.cost)} for the load (under ${Math.round(policy.minCashShare * 100)}%)` };
  }
  return { ok: true, reason: `score ${Math.round(nowScore)} vs ${Math.round(planned.leg2Score)} planned` };
}

export const circuitExpired = (planned: PlannedCircuit, nowMs: number, policy: CircuitPolicy): boolean =>
  nowMs - planned.at > policy.ttlMinutes * 60_000;
