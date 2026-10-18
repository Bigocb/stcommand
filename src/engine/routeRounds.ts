/**
 * Route round limit: a route may run only so many trips in a window, whichever ship runs them.
 *
 * The route cool-off (routeHeat.ts) reacts to a trip that DISAPPOINTED, which lets a profitable route be run over and
 * over into the ground: 2026-10-18, THEOREM-5 ran MEDICINE E52 > G58 four times in six minutes on a market that takes a
 * median of 124 minutes to recover, and it was the fourth round that lost. Rounds one and two beat their promise, so
 * nothing rested the route. The market itself does not care which ship runs a route, so this counts trips per route,
 * not per ship.
 *
 * Pure: the caller passes the closed trips it has seen and the clock. `maxRounds` 0 (or no window) switches it off.
 */

import type { RouteTrip } from "./routeHeat.js";

export interface RoundsPolicy { maxRounds: number; windowMin: number }
export const ROUNDS_WINDOW_MIN = 60;

/** Why this route is resting under the round limit, or undefined when it may run. */
export function roundsReason(trips: readonly RouteTrip[], good: string, buyAt: string, sellAt: string, now: number, policy: RoundsPolicy): string | undefined {
  if (!(policy.maxRounds > 0) || !(policy.windowMin > 0)) return undefined;
  const since = now - policy.windowMin * 60_000;
  const inWindow = trips.filter((t) => t.good === good && t.buyAt === buyAt && t.sellAt === sellAt && t.at >= since);
  if (inWindow.length < policy.maxRounds) return undefined;
  // The route reopens when the oldest counted trip leaves the window; every counted trip is inside it, so this is > 0.
  const oldest = Math.min(...inWindow.map((t) => t.at));
  const leftMin = (oldest + policy.windowMin * 60_000 - now) / 60_000;
  return `resting ${Math.ceil(leftMin)} more min: ${inWindow.length} trips on this route in the last ${policy.windowMin} min (limit ${policy.maxRounds})`;
}
