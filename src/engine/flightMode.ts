import type { components } from "../core/client.js";

export type FlightMode = components["schemas"]["ShipNavFlightMode"];

/**
 * Chooses a flight mode for one leg, purely from this ship's own current
 * fuel situation — no fleet-wide coordination, matching how every other
 * navigation decision in this codebase is already made per-ship (see
 * CONTEXT.md: there is no centralized dispatcher for this kind of choice).
 *
 * `needFuelAtCruise` is the same distance-based estimate each agent class
 * already computes before every navigate call (`estimatedFuelTo`/
 * `distBetween`) — this function doesn't add a new estimation path, it
 * just decides what to do with the existing one.
 *
 * DRIFT's exact fuel/time formula is NOT verified against the live game in
 * this codebase — docs.spacetraders.io was unreachable from this sandbox
 * when this was written, and no reliable secondary source turned up the
 * precise numbers either. What's not in doubt is DRIFT's purpose: it costs
 * meaningfully less fuel than CRUISE for the same distance, in exchange for
 * a much longer transit. So it's used here only as a last resort — when the
 * ship can't afford this leg at CRUISE at all. That's a strict improvement
 * over the prior behavior (give up, log "cannot navigate", sit still)
 * regardless of DRIFT's exact fuel curve, since any successful navigation
 * beats none. If DRIFT also turns out to be unaffordable for this leg, the
 * real navigate API call rejects it exactly as an unreachable CRUISE leg
 * already was — this never makes stranding worse, only sometimes avoids it.
 *
 * BURN's assumed tradeoff (roughly double CRUISE's fuel for roughly half
 * the transit time) is a commonly-cited approximation, also not verified
 * live here. Unlike DRIFT, getting this threshold wrong is a low-stakes
 * economic inefficiency (spending fuel a little too eagerly or too
 * conservatively for the time saved) rather than a stranding risk, so it's
 * gated more liberally: chosen only when the ship could pay double the
 * CRUISE cost and still keep a real reserve (a quarter tank) afterward —
 * not just "can afford this one trip." If the real ratio turns out to be
 * different, this threshold is the one place to retune it.
 */
export function chooseFlightMode(needFuelAtCruise: number, currentFuel: number, capacity: number): FlightMode {
  if (capacity <= 0) return "CRUISE"; // fuel-independent ship (see CONTEXT.md's Fuel-independent Ship entry) — mode is meaningless
  if (currentFuel < needFuelAtCruise) return "DRIFT";
  if (currentFuel >= needFuelAtCruise * 2 && currentFuel - needFuelAtCruise * 2 >= capacity * 0.25) return "BURN";
  return "CRUISE";
}
