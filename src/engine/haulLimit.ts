/**
 * How many gate jumps a ship may carry cargo across. Positioning an empty ship over many gates costs time and a few jump
 * fees; a loaded one that is turned back (a gate that stopped verifying, a market that moved) has to sell somewhere else
 * from where it stands, which has meant a second ten-jump trek with the same hold (2026-10-22: THEOREM-C4, 225 MACHINERY).
 * Pure: the caller supplies the hop count. `limit` undefined (clause off) allows any length, which is the behaviour before this existed.
 */
export function haulLegVerdict(hops: number, limit: number | undefined): { ok: true } | { ok: false; reason: string } {
  if (limit === undefined || hops <= limit) return { ok: true };
  return { ok: false, reason: `the buy-to-sell leg is ${hops} gate jumps, over the hauled-jumps limit of ${limit}` };
}

/** True when a path of `hops` jumps is within the limit (no limit = always), for a redirect's reachable() test. */
export function withinHaulLimit(hops: number | undefined, limit: number | undefined): boolean {
  return hops !== undefined && (limit === undefined || hops <= limit);
}

/**
 * The per-speed route-shape clause (docs/slow-hull-local-routes-spec.md). A hull at or below `speed` (most light hulls are
 * 15; freighters 36-60) may only be offered short loaded legs and short empty positioning, while fast hulls keep the
 * current behaviour. Either cap left undefined switches that half of the clause off, so all of them off is today's fleet.
 */
export interface SlowHullPolicy {
  /** Engine speed at or below which a hull counts as slow. */
  speed: number;
  /** Most gate jumps on the loaded (buy -> sell) leg for a slow hull; undefined = no cap here. */
  hauledHops?: number;
  /** Most gate jumps a slow hull may travel empty to a route's buy market; undefined = no cap here. */
  positioningHops?: number;
}

/** Unknown speed counts as slow: most hulls are 15, so a hull whose speed we cannot read is assumed to be one of them. */
export function isSlowHull(shipSpeed: number | undefined, speed: number): boolean {
  return shipSpeed === undefined || shipSpeed <= speed;
}

/**
 * Whether a slow hull may take a leg of `hops` gate jumps — the loaded buy-to-sell leg (`"hauled"`) or the empty leg to
 * the route's buy market (`"positioning"`). Pure: the caller supplies the hop count. Fast hulls and a half whose cap is
 * undefined allow everything; an unknown hop count (no known path) is left to the reachability checks that already
 * refused it.
 */
export function slowHullVerdict(
  shipSpeed: number | undefined,
  hops: number | undefined,
  policy: SlowHullPolicy,
  leg: "hauled" | "positioning" = "hauled",
): { ok: true } | { ok: false; reason: string } {
  if (!isSlowHull(shipSpeed, policy.speed)) return { ok: true };
  const limit = leg === "hauled" ? policy.hauledHops : policy.positioningHops;
  if (limit === undefined || hops === undefined || hops <= limit) return { ok: true };
  return leg === "hauled"
    ? { ok: false, reason: `slow hull: loaded leg is ${hops} gate jumps, over the slow-hull limit of ${limit}` }
    : { ok: false, reason: `slow hull: the buy market is ${hops} gate jumps away, over the slow-hull positioning limit of ${limit}` };
}
