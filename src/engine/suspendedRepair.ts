/**
 * Suspended repairs: what to do with a ship whose agent is suspended while its condition is below the repair floor.
 *
 * Why this exists: a repair is proposed to the ship's own agent, and a suspended agent never runs it. Three miners sat
 * for hours this way (THEOREM-7/-8/-9, condition 0.17 to 0.20, suspended, not moving). This module lets the engine
 * fly such a ship to a shipyard itself and repair it there.
 *
 * Pure. The caller (FleetManager.repairSuspendedShips()) fills in each ship's facts and acts on the answer. No I/O,
 * no clock.
 */

export interface SuspendedRepairPolicy {
  /** Off means every suspended ship is left alone, as before. */
  enabled: boolean;
  /** Repair when the worst component's condition (0..1) is below this. Doctrine repairConditionFloor, by default. */
  floor: number;
}

export const DEFAULT_SUSPENDED_REPAIR_POLICY: SuspendedRepairPolicy = { enabled: true, floor: 0.5 };

export interface SuspendedRepairFacts {
  shipSymbol: string;
  /** The agent is suspended. Only suspended ships are handled here; a running agent repairs itself. */
  suspended: boolean;
  /** Worst component condition 0..1. */
  condition: number;
  /** Nav state from the live ship. */
  nav: "DOCKED" | "IN_ORBIT" | "IN_TRANSIT";
  system: string;
  waypoint: string;
  /** The shipyard at the ship's own waypoint, if it is one. */
  atShipyard: boolean;
  /** The nearest shipyard in the ship's own system, if the system has one known. */
  nearestYard?: string;
}

export type SuspendedRepairAction =
  | { kind: "repair" }
  | { kind: "dock" }
  | { kind: "fly"; yard: string }
  | { kind: "wait" }
  | { kind: "none" };

export interface SuspendedRepairDecision {
  shipSymbol: string;
  action: SuspendedRepairAction;
  /** One-line reason, for the activity log. */
  reason: string;
}

/** Decide, for each suspended ship, whether to repair it here, fly it to a yard, wait, or leave it. */
export function planSuspendedRepairs(
  facts: SuspendedRepairFacts[],
  policy: SuspendedRepairPolicy = DEFAULT_SUSPENDED_REPAIR_POLICY,
): SuspendedRepairDecision[] {
  return facts.map((f) => decide(f, policy));
}

function decide(f: SuspendedRepairFacts, policy: SuspendedRepairPolicy): SuspendedRepairDecision {
  const none = (reason: string): SuspendedRepairDecision => ({ shipSymbol: f.shipSymbol, action: { kind: "none" }, reason });
  if (!policy.enabled) return none("suspended repairs are off");
  if (!f.suspended) return none("agent is running; it handles its own repair");
  if (f.condition >= policy.floor) return none(`condition ${f.condition.toFixed(2)} is at or above the floor ${policy.floor.toFixed(2)}`);
  if (f.nav === "IN_TRANSIT") return { shipSymbol: f.shipSymbol, action: { kind: "wait" }, reason: "in transit; repair once it docks" };
  // Arrived at the yard but still in orbit: dock, then repair on the next tick. Without this the ship is sent to the
  // yard it is already at, every pass, and never repaired.
  if (f.nav === "IN_ORBIT" && f.atShipyard) {
    return { shipSymbol: f.shipSymbol, action: { kind: "dock" }, reason: `condition ${f.condition.toFixed(2)}, in orbit at a shipyard: docking` };
  }
  if (f.nav === "DOCKED" && f.atShipyard) {
    return { shipSymbol: f.shipSymbol, action: { kind: "repair" }, reason: `condition ${f.condition.toFixed(2)}, docked at a shipyard` };
  }
  if (!f.nearestYard) return none(`condition ${f.condition.toFixed(2)}, but no known shipyard in ${f.system}`);
  return {
    shipSymbol: f.shipSymbol,
    action: { kind: "fly", yard: f.nearestYard },
    reason: `condition ${f.condition.toFixed(2)}, suspended: flying to ${f.nearestYard} to repair`,
  };
}
