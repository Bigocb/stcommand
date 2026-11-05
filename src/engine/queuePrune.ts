/**
 * Which queued systems to drop for having no shipyard.
 *
 * Operator rule (2026-10-22): a system with no shipyard is not worth covering, because a keeper can only be bought where one of our ships
 * is docked at a yard. Doctrine exploreMinShipyards applies that rule to systems found from now on; this applies it to the ones already in
 * the fresh-system queue (84 of 318 had no yard on 2026-11-05, X1-CK56 among them before it was released).
 *
 * Only a SCOUTED, un-held system is dropped: a staged one has keepers bought for it, a live one is trading, and a hold is the operator
 * pinning it. A system with an uncharted waypoint is kept, since an uncharted waypoint hides its traits and the yard may be there.
 * Pure: facts in, the systems to drop and one-line reasons out. A minimum of 0 drops nothing (the clause off).
 */

export interface PruneFacts {
  system: string;
  state: "scouted" | "staged" | "live";
  held: boolean;
  /** Undefined when the system's waypoints are not known: nothing is dropped on a guess. */
  shipyards?: number;
  uncharted?: number;
}

export function systemsToDrop(queue: readonly PruneFacts[], minShipyards: number): { system: string; reason: string }[] {
  if (minShipyards <= 0) return [];
  const out: { system: string; reason: string }[] = [];
  for (const q of queue) {
    if (q.state !== "scouted" || q.held) continue;
    if (q.shipyards === undefined) continue;
    if ((q.uncharted ?? 0) > 0) continue;
    if (q.shipyards < minShipyards) out.push({ system: q.system, reason: `${q.shipyards} shipyard(s), needs ${minShipyards}` });
  }
  return out;
}
