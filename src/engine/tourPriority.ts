/**
 * Tour scheduling while a tour ship is mid-trip: how urgent its next tick is, and when it should run again.
 *
 * Why this exists: a tour ship on a multi-hop trip (a warp or a gate hop toward a dispatched system) waited behind the
 * whole fleet in the shared API budget, so one hop could take ~15 minutes of queue time. While a tour is under way,
 * its next tick should jump the queue a little, and a ship in transit should wake when it arrives, not poll before.
 *
 * Pure. No I/O, no clock. The agent fills in the facts and acts on the answer. The clause is doctrine-backed (see
 * DOCTRINE_CATALOG `tourHopPriority`), so turning it off restores today's behaviour exactly.
 */

export interface TourPriorityPolicy {
  /** Doctrine clause toggle. Off means every tour task keeps its base priority and runs as before. */
  enabled: boolean;
  /** Priority of a tour task with a trip under way. Lower runs first; the base tour priority is 3. */
  basePriority: number;
  midTripPriority: number;
}

export const DEFAULT_TOUR_PRIORITY_POLICY: TourPriorityPolicy = { enabled: true, basePriority: 3, midTripPriority: 2 };

export interface TourTimingFacts {
  /** The fleet has a dispatched tour destination for this ship (a multi-hop trip is under way). */
  hasTourDestination: boolean;
  inTransit: boolean;
  /** Arrival time in epoch ms, when the ship is in transit and the API gave one. */
  arrivalMs?: number;
}

/** The priority a tour task should carry, and why. */
export function tourTaskPriority(facts: TourTimingFacts, policy: TourPriorityPolicy = DEFAULT_TOUR_PRIORITY_POLICY): { priority: number; reason: string } {
  if (!policy.enabled) return { priority: policy.basePriority, reason: "tour priority boost is off" };
  if (facts.hasTourDestination || facts.inTransit) {
    return { priority: policy.midTripPriority, reason: "tour trip under way: boosted" };
  }
  return { priority: policy.basePriority, reason: "no tour trip under way" };
}

/**
 * When the tour should next run. A ship in transit cannot act before it lands, so with an arrival time it waits for
 * that moment rather than spending a queue slot on a tick that can only say "still flying". Otherwise a tick that did
 * work runs again straight away, and an idle one waits 30 seconds, as before.
 */
export function tourNextRunAt(now: number, madeWork: boolean, facts: TourTimingFacts, policy: TourPriorityPolicy = DEFAULT_TOUR_PRIORITY_POLICY): number {
  if (policy.enabled && facts.inTransit && facts.arrivalMs !== undefined && facts.arrivalMs > now) return facts.arrivalMs;
  return now + (madeWork ? 0 : 30_000);
}
