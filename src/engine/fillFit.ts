/**
 * Fill fit: send big holds to deep markets (operator, 2026-11-20: "consider hold size vs buy size when assigning ships").
 *
 * The dispatcher already scores a route for a ship on what that ship's hold earns there (`routeHoldAware`, profitByHold, capped
 * at the route's depth). What it does not count is the hold left empty: a 225-hold heavy on a market that takes 48 units earns
 * what an 80-hold ship would, while a deep route that only the heavy can fill sits unflown (THEO-408, 2026-11-20, issue #64).
 * Fill fit scales a route's score for a ship by how much of the ship's hold the route fills, so a big hull prefers deep routes
 * and the shallow ones fall to the small hulls.
 *
 * Depth is the route's own `volume`: the units at which the trip's profit peaks after our price impact on both sides
 * (`sizeForImpact` in lotImpact.ts), capped by cash and the biggest hold.
 *
 * Pure: no I/O, no clock, no globals. Policy is data (doctrine `routeFillFit`, weight in percent); weight 0 changes nothing.
 */

export interface FillPolicy {
  /** 0-100: how much an empty share of the hold costs. 0 = off (factor always 1); 100 = score scaled by the fill share itself. */
  weightPct: number;
}

export const DEFAULT_FILL_POLICY: FillPolicy = { weightPct: 0 };

/** Share of a hold this route fills: depth / hold, capped at 1. Undefined when either is unknown. */
export function fillShare(depth: number | undefined, hold: number): number | undefined {
  if (depth === undefined || !(depth > 0) || !(hold > 0)) return undefined;
  return Math.min(1, depth / hold);
}

/** The score multiplier: 1 - w + w x fill. 1 with the policy off or the depth unknown. */
export function fillFactor(depth: number | undefined, hold: number, policy: FillPolicy = DEFAULT_FILL_POLICY): number {
  const w = Math.min(100, Math.max(0, policy.weightPct)) / 100;
  if (w === 0) return 1;
  const fill = fillShare(depth, hold);
  if (fill === undefined) return 1;
  return 1 - w + w * fill;
}

/** One line for logs and explain: "fills 48/225 (21%), score x0.61". Empty when the factor is 1. */
export function fillNote(depth: number | undefined, hold: number, policy: FillPolicy): string {
  const f = fillFactor(depth, hold, policy);
  if (f === 1 || depth === undefined) return "";
  const fill = fillShare(depth, hold)!;
  return `fills ${Math.min(Math.round(depth), hold)}/${hold} (${Math.round(fill * 100)}%), score x${f.toFixed(2)}`;
}
