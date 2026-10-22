/**
 * Whether a newly charted system is worth an explorer's tour.
 *
 * Operator rule (2026-10-22): after the initial survey, a system with no
 * shipyard or fewer than five markets is not touring material. It is marked
 * rejected so no other explorer flies there, and the explorer moves on. A
 * shipyard matters because a keeper can only be bought where a ship is docked at
 * one; the market count matters because a tour only pays when there are enough
 * prices to read.
 *
 * Policy is data: a minimum of 0 switches that criterion off, and both at 0
 * accepts every system, which is the behaviour before this existed.
 * Pure: counts in, verdict and a one-line reason out.
 */

export interface SystemCounts { markets: number; shipyards: number }
export interface WorthPolicy { minMarkets: number; minShipyards: number }

export function judgeSystem(c: SystemCounts, p: WorthPolicy): { good: boolean; reason: string } {
  const fails: string[] = [];
  if (c.shipyards < p.minShipyards) fails.push(`${c.shipyards} shipyard(s), needs ${p.minShipyards}`);
  if (c.markets < p.minMarkets) fails.push(`${c.markets} market(s), needs ${p.minMarkets}`);
  return fails.length === 0
    ? { good: true, reason: `${c.markets} markets and ${c.shipyards} shipyard(s): worth a tour` }
    : { good: false, reason: fails.join("; ") };
}

/** Count markets and shipyards from a system's waypoint traits. */
export function countWaypoints(waypoints: readonly { traits?: readonly { symbol: string }[] }[]): SystemCounts {
  const has = (w: { traits?: readonly { symbol: string }[] }, t: string) => (w.traits ?? []).some((x) => x.symbol === t);
  return { markets: waypoints.filter((w) => has(w, "MARKETPLACE")).length, shipyards: waypoints.filter((w) => has(w, "SHIPYARD")).length };
}
