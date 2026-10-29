/**
 * What a hull's own speed is worth to a route.
 *
 * Route economics cost every route's flying time at ONE speed, the slowest hull in the fleet (fleet.ts: any idle trader
 * could be handed it, and most hulls are 15-speed shuttles). That keeps the board honest for the slow hulls, but it
 * values a speed-60 freighter the same as a speed-15 shuttle: the dispatcher and the route matcher both ignored that a
 * fast ship finishes a same-system trip in a quarter of the time and so earns that much more per hour from the same
 * route.
 *
 * `speedGain` is the factor to multiply a flight-bound route's per-hour value by for one ship. It is 1 for a ship at the
 * modelled speed, and the policy decides how much of the real speed advantage is believed. Weight 0 gives 1 for every
 * ship, which reproduces today's behaviour.
 *
 * Pure: no I/O, no clock, no globals.
 */

export interface SpeedPolicy {
  /** Share of the real speed advantage to count, in percent. 0 switches the feature off, 100 takes the ratio at face value. */
  weightPct: number;
  /** The largest ratio ever counted, so one odd speed reading cannot swamp the ranking. */
  maxRatio: number;
}

export const DEFAULT_SPEED_POLICY: SpeedPolicy = { weightPct: 0, maxRatio: 4 };

/** Per-hour multiplier for a ship of `shipSpeed` on a route costed at `modelSpeed`; 1 when off or either speed is unknown. */
export function speedGain(shipSpeed: number | undefined, modelSpeed: number | undefined, policy: SpeedPolicy): number {
  if (policy.weightPct <= 0 || !shipSpeed || !modelSpeed || shipSpeed <= 0 || modelSpeed <= 0) return 1;
  const ratio = Math.min(Math.max(shipSpeed / modelSpeed, 1 / policy.maxRatio), policy.maxRatio);
  return 1 + (Math.min(100, policy.weightPct) / 100) * (ratio - 1);
}

/** The same flying time for this ship: a faster hull spends less of it. */
export function scaleSeconds(seconds: number, gain: number): number {
  return gain > 0 ? seconds / gain : seconds;
}

/** One line for the dispatch log, only when the speed changed the value. */
export function speedReason(shipSymbol: string, shipSpeed: number | undefined, modelSpeed: number | undefined, gain: number): string | undefined {
  if (gain === 1) return undefined;
  return `${shipSymbol} speed ${shipSpeed} vs ${modelSpeed} modelled: same-system routes valued x${gain.toFixed(2)}`;
}
