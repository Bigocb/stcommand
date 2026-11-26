/**
 * Short or long: how a route's loaded leg compares with what a light hauler may fly.
 *
 * Operator, 2026-11-26: tag route cards long or short and filter by it, after the slow-hull limit
 * (slowHullHauledHops) kept the speed-15 light haulers to short legs and left the long ones to heavies and bulks.
 * A route is short when its buy-to-sell leg crosses no more gates than that limit (0 = same system), long when it
 * crosses more, and unknown when no gate path is known. Pure: the caller supplies the hop count and the limit.
 */

export type RouteLength = "short" | "long";

export interface RouteLengthInfo {
  /** Gate jumps on the loaded leg, buy system to sell system; null when no path is known. */
  hops: number | null;
  /** short = a light hauler may fly the loaded leg; long = heavies and bulks only; null when hops is unknown. */
  length: RouteLength | null;
}

export function classifyRouteLength(hops: number | undefined | null, shortMaxHops: number): RouteLengthInfo {
  if (hops === undefined || hops === null || !Number.isFinite(hops) || hops < 0) return { hops: null, length: null };
  const limit = Math.max(0, Math.floor(shortMaxHops));
  return { hops, length: hops <= limit ? "short" : "long" };
}
