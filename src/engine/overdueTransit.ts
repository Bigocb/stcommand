/**
 * A ship the engine's model still shows as flying, though the arrival time it was given has long passed.
 *
 * Arrival is normally reconciled exactly once: `navigateTo()` raises `NavigationPending(resumeAt)` and the ship's task wakes
 * at that arrival, re-reads the ship and continues. If that single request fails (a transient `fetch failed`, the box's
 * network blipping), nothing ever retries it: the model keeps the ship IN_TRANSIT forever, the dispatcher counts it as
 * en route, and once every trader is in that state the whole fleet goes quiet while still looking healthy. Confirmed live
 * 2026-11-10 (fleet at 5 calls/min with every trader "in transit" while the game showed them docked; a restart cleared it).
 *
 * This predicate is the repair trigger: FleetManager re-reads only ships that satisfy it, every minute, so the grace period
 * must be long enough that a healthy just-arrived ship (whose own wake-up is milliseconds away) is not re-read needlessly.
 *
 * Pure: a nav-like object, the clock, the grace, no I/O.
 */
export interface TransitNavLike {
  status?: string;
  route?: { arrival?: string } | null;
}

/** True when `nav` is IN_TRANSIT and its arrival is more than `graceMs` in the past (an unparseable/missing arrival is not overdue). */
export function isOverdueTransit(nav: TransitNavLike | undefined | null, nowMs: number, graceMs: number): boolean {
  if (!nav || nav.status !== "IN_TRANSIT") return false;
  const at = nav.route?.arrival ? Date.parse(nav.route.arrival) : Number.NaN;
  return Number.isFinite(at) && nowMs - at > graceMs;
}
