/**
 * Keeper-probe purchasing without an operator in the loop, and without a ship
 * having to happen to dock.
 *
 * Two pure decisions, both used by FleetManager's keeper-probe paths:
 *
 *  - keeperAutoApprove(): may this purchase skip the approval card? Only when the
 *    `autoApproveKeeperProbes` clause is on, the price is at or under its cap and
 *    the credits are spendable. A probe is cheap (28,959c on 2026-10-22) next to
 *    the price data it brings, which is why a cap, not a prompt, is the control.
 *  - pickShipAtYard(): which of our ships can stand in for "a ship docked at the
 *    shipyard" (SpaceTraders sells a ship only to an agent that has one there).
 *    A keeper already stationed at the yard is always there, so a market's probe
 *    can be bought without waiting for a passing ship to dock.
 *
 * Pure: no I/O, no clock. Clause off must reproduce today's behaviour (every
 * purchase asks the operator), which keeperAutoApprove({clauseOn:false}) does.
 */

export interface KeeperAutoApproveInput {
  clauseOn: boolean;
  /** Highest price the operator allows without asking, in credits. */
  capCredits: number;
  price: number;
  /** Whether the wallet can pay it above the cash floor (FleetManager.canAfford). */
  spendable: boolean;
}

export function keeperAutoApprove(i: KeeperAutoApproveInput): { approve: boolean; reason: string } {
  if (!i.clauseOn) return { approve: false, reason: "autoApproveKeeperProbes is off: the operator decides" };
  if (!Number.isFinite(i.price) || i.price <= 0) return { approve: false, reason: `price ${i.price} is not a real quote` };
  if (i.price > i.capCredits) return { approve: false, reason: `${i.price}c is over the ${i.capCredits}c auto-approve cap` };
  if (!i.spendable) return { approve: false, reason: `${i.price}c is more than the spendable credits` };
  return { approve: true, reason: `${i.price}c is within the ${i.capCredits}c auto-approve cap` };
}

export interface ShipAtWaypoint { symbol: string; role: string; waypoint: string; nav: string }

/**
 * A ship that is at `yard` and not mid-flight, preferring one that has no other
 * job there: a keeper first (it is permanently stationed and docking it costs
 * nothing), then any other role. Undefined when none of ours is there.
 */
export function pickShipAtYard(ships: readonly ShipAtWaypoint[], yard: string): string | undefined {
  const here = ships.filter((s) => s.waypoint === yard && s.nav !== "IN_TRANSIT");
  return (here.find((s) => s.role === "keeper") ?? here[0])?.symbol;
}

/**
 * The marketplaces of a freshly toured system that the keeper priority list does not hold yet, in waypoint order. Used when a
 * system has passed the explorer's worth threshold: every market in it gets a keeper, the way the operator did by hand.
 * Waypoint symbols are upper-case already; the list is compared exactly.
 */
export function marketsNeedingKeepers(
  waypoints: readonly { symbol: string; traits?: readonly { symbol: string }[] }[],
  listed: readonly string[],
): string[] {
  const have = new Set(listed);
  return waypoints
    .filter((w) => (w.traits ?? []).some((t) => t.symbol === "MARKETPLACE") && !have.has(w.symbol))
    .map((w) => w.symbol);
}
