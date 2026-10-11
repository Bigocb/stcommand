import { MIN_MARGIN_PCT, PRICE_IMPACT_PER_LOT } from "./routeEconomics.js";

/**
 * How many back-to-back runs a route can make before our own trading closes its margin: the "runs left" hint on the
 * Routes board. Profit per hour (the dispatcher's score) assumes a route can be repeated; this says for how long.
 *
 * Model: each run lifts the buy price and sinks the sell price by PRICE_IMPACT_PER_LOT per lot (a market's tradeVolume)
 * of our units, compounding, and prices do NOT recover between runs (measured 2026-10-11: FOOD at A1 kept falling over
 * 9 minutes with none of our sales, DRUGS at H57 over 20). Runs are counted while the per-unit spread still clears the
 * fuel per unit and the margin floor. Display only: nothing in the engine acts on it, and the dispatcher still rescores
 * every minute from real prices.
 *
 * Pure: no I/O, no clock. Policy is data, so a measured correction does not touch the callers.
 */
export interface RunsPolicy {
  /** Price impact per lot, before the correction below. */
  impactPerLot: number;
  /** Measured runs erode ~1.25x the per-lot model once drift between runs is counted (FOOD K100 -> A1: 7.9% and 9.4% per
   *  80u run observed vs 6.0% modelled at tradeVolume 60). 1 reproduces the plain model. */
  observedFactor: number;
  /** Flat per-unit floor and the share-of-buy-price floor, as the dispatcher's own margin test (effectiveMarginFloor). */
  flatFloor: number;
  floorPct: number;
  /** Stop counting here and report "N+". */
  cap: number;
}
export const DEFAULT_RUNS_POLICY: RunsPolicy = { impactPerLot: PRICE_IMPACT_PER_LOT, observedFactor: 1.25, flatFloor: 10, floorPct: MIN_MARGIN_PCT, cap: 12 };

export interface RunsInput {
  buyPrice: number;
  sellPrice: number;
  /** Units one run carries. */
  units: number;
  buyVolume: number;
  sellVolume: number;
  /** Fuel (or jump) credits for one run. */
  fuelCostPerRun: number;
}

export interface RunsLeft {
  runs: number;
  /** True when the cap was reached, so the true number is at least `runs`. */
  capped: boolean;
  /** One line a person can check. */
  reason: string;
}

export function runsLeft(i: RunsInput, policy: RunsPolicy = DEFAULT_RUNS_POLICY): RunsLeft {
  const units = Math.max(1, i.units);
  const rise = policy.impactPerLot * policy.observedFactor * (units / Math.max(1, i.buyVolume));
  const fall = policy.impactPerLot * policy.observedFactor * (units / Math.max(1, i.sellVolume));
  const floor = Math.max(policy.flatFloor, i.buyPrice * policy.floorPct);
  const fuelPerUnit = i.fuelCostPerRun / units;
  const spreadAt = (k: number): number => i.sellPrice * Math.pow(1 - fall, k) - i.buyPrice * Math.pow(1 + rise, k);

  let runs = 0;
  while (runs < policy.cap && spreadAt(runs) - fuelPerUnit > floor) runs++;
  const capped = runs >= policy.cap;
  const first = Math.round(spreadAt(0));
  const reason = capped
    ? `margin ${first}/unit now, still above the floor after ${policy.cap} runs at ${(rise * 100).toFixed(1)}% buy rise and ${(fall * 100).toFixed(1)}% sell fall per run`
    : runs === 0
      ? `margin ${first}/unit is already at or under the floor`
      : `margin ${first}/unit now, ~${Math.round(spreadAt(runs))}/unit after ${runs} runs (floor ${Math.round(floor + fuelPerUnit)}), at ${(rise * 100).toFixed(1)}% buy rise and ${(fall * 100).toFixed(1)}% sell fall per run`;
  return { runs, capped, reason };
}
