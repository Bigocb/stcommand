/**
 * Whether a route is a big enough prize for a big hull.
 *
 * Operator observation (2026-11-05): with the hour falling, the 225-unit Heavy Freighters were being handed ore and fuel routes
 * worth 1,000 to 4,000 a trip (THEO-12D made 26k in an hour on 18 sells) while routes worth 30k to 50k a trip sat unclaimed
 * because they score lower on distance. A hull this size is the fleet's scarcest capital; a trip that cannot pay for it is a
 * waste of its hours. Pinning each one by hand works, but the pins go stale as prices move.
 *
 * The rule: a hull whose hold is `bigHold` or more takes a route only when the route pays at least `minTrip` credits a trip
 * priced at THAT hull's hold. Smaller hulls are not restricted. A route that fails is a FALLBACK, not a ban: the dispatcher
 * serves the hull the best route that fits, and only when none does, the best one that does not, so a heavy never idles on
 * account of this rule (an idle 2M hull earns nothing either).
 *
 * Pure: numbers in, verdict and a one-line reason out. Policy is data, backed by the doctrine clauses routeFitMinTrip (off by
 * default; a minTrip of 0 reproduces today's behaviour) and routeFitBigHold.
 */

export interface FitPolicy {
  /** Hulls with at least this much hold are subject to the rule. */
  bigHold: number;
  /** The least a route must pay per trip, at the hull's own hold. 0 switches the rule off. */
  minTrip: number;
}

export const NO_FIT_RULE: FitPolicy = { bigHold: 0, minTrip: 0 };

export interface FitVerdict {
  ok: boolean;
  /** Why not, for dispatch_explain and the log. */
  reason?: string;
}

/** `earns` is what this hull's hold makes from the route in one trip. */
export function routeFit(earns: number, capacity: number, policy: FitPolicy): FitVerdict {
  if (policy.minTrip <= 0) return { ok: true };
  if (capacity < policy.bigHold) return { ok: true };
  if (earns >= policy.minTrip) return { ok: true };
  return { ok: false, reason: `too small a prize for a ${capacity}-unit hull: ${Math.round(earns)} a trip, needs ${policy.minTrip}` };
}
