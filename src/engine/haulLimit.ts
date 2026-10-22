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
