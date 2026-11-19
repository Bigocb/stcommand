/**
 * The trip length a route's score is scaled by (issue #55).
 *
 * Why it exists (2026-11-19): the dispatcher ranks a route as profit per 600 s of trip time (scoreRoute()). A same-system hop
 * between two neighbouring waypoints has a modelled trip of a few tens of seconds, so a trivial profit became a huge rate:
 * FUEL X1-DT25-E19A -> F16F, 2,663 a trip on a 15c spread, ranked at 49,931, above real 50k+ ANTIMATTER routes, and a trader
 * was handed it. A real trip never takes that little: docking, buying, undocking, flying, docking and selling take minutes.
 *
 * With a floor (clause routeMinTripSeconds on), the trip time used for scaling is never below the floor, so no route's rate is
 * inflated more than REFERENCE / floor times its trip profit. Off (floor 0): exactly the old scaling.
 *
 * Pure: no I/O, no clock.
 */

export interface TripScalePolicy {
  /** The reference trip length the score is scaled to (REFERENCE_TRIP_SECONDS). */
  referenceSeconds: number;
  /** Shortest trip time the scaling may assume; 0 = no floor (the old behaviour). */
  minTripSeconds: number;
}

/** The trip seconds to scale by: the route's own, raised to the floor. Undefined stays undefined (score not time-scaled). */
export function scaledTripSeconds(tripSeconds: number | undefined, policy: Pick<TripScalePolicy, "minTripSeconds">): number | undefined {
  if (!tripSeconds || tripSeconds <= 0) return undefined;
  return policy.minTripSeconds > 0 ? Math.max(tripSeconds, policy.minTripSeconds) : tripSeconds;
}

/** A trip profit as a rate per reference trip length. A route without a trip time keeps its trip profit. */
export function profitPerReference(profitPerTrip: number, tripSeconds: number | undefined, policy: TripScalePolicy): number {
  const t = scaledTripSeconds(tripSeconds, policy);
  return t ? (profitPerTrip * policy.referenceSeconds) / t : profitPerTrip;
}
