/**
 * Warp tours: how a tour ship crosses to another system when it has a warp drive, instead of walking the gate graph.
 *
 * Pure. The caller (FleetManager.hopToward(), TraderAgent.warpTo()) fills in the ship's warp range, fuel and tank,
 * the distance to the target system, any fuel need the game has already reported, and the policy, and acts on the
 * answer, including setting the chosen flight mode before it warps. Warping skips the gate entirely: no jump cost, no gate cooldown, and
 * no need for the target system's gate to be finished. Anything that can't warp falls back to the gate path unchanged.
 */

export type HopMethod = "warp" | "gate";

/** Flight modes a warp is issued in. DRIFT is never used for a warp: its fuel curve is unverified for warps. */
export type WarpFlightMode = "CRUISE" | "BURN";

/**
 * Fuel per distance unit, relative to CRUISE. Measured live 2026-10-15 on THEOREM-86 in BURN: two different distances
 * (about 435 and 581 units) cost 868 and 1,160 fuel, both 2.0x the distance. So CRUISE is 1x, BURN is 2x, the same as
 * an in-system navigate (routeEconomics.ts legTravel()).
 */
export const WARP_MODE_FUEL_MULTIPLIER: Record<WarpFlightMode, number> = { CRUISE: 1, BURN: 2 };

export interface WarpPolicy {
  /** Doctrine clause toggle. Off means every hop goes through a gate, as before. */
  enabled: boolean;
  /** Fuel per galaxy distance unit at CRUISE. Calibrated from the live measurements above: 1. */
  fuelPerUnit: number;
  /**
   * Multiplier on an estimate (not on a fuel need the game has already told us). A rejected warp spends no fuel, the
   * API refuses it up front, so a small margin is enough.
   */
  fuelMargin: number;
}

export const DEFAULT_WARP_POLICY: WarpPolicy = { enabled: true, fuelPerUnit: 1, fuelMargin: 1.05 };

export interface WarpHopFacts {
  /** Range of the installed warp drive module, or undefined when the ship has no warp drive. */
  warpRange?: number;
  /** Current fuel units. */
  fuel: number;
  /** Tank size. Used to keep a reserve before choosing BURN, and to say when a warp can never fit the tank. */
  capacity?: number;
  /** Galaxy distance from the ship's system to the target system, or undefined when not yet known. */
  distance?: number;
  /**
   * Fuel this exact warp needs at CRUISE, as the game itself reported it (from a rejection's "requires N more fuel", or
   * a completed warp's fuel drop). Beats the distance estimate whenever it is known.
   */
  knownCruiseNeed?: number;
}

export interface WarpHopChoice {
  method: HopMethod;
  /** One line for the log, saying why this method was picked. */
  reason: string;
  /** Fuel the warp needs in the chosen mode (or at CRUISE when it can't warp). Undefined when it wasn't computed. */
  fuelNeeded?: number;
  /** Galaxy distance the warp covers, echoed from the facts so the caller can log it. */
  distance?: number;
  /** The mode to set before warping. Only present when method is "warp". */
  flightMode?: WarpFlightMode;
}

/** Range of the first installed warp drive module, if any. */
export function warpDriveRange(modules: readonly { symbol: string; range?: number }[] | undefined): number | undefined {
  const drive = modules?.find((m) => m.symbol.startsWith("MODULE_WARP_DRIVE_"));
  if (!drive) return undefined;
  // A module missing its range is treated as unknown rather than as zero, so it doesn't rule out a warp that would
  // have worked. The API's own rejection still stops a bad warp, and the caller falls back to the gate on any error.
  return drive.range ?? Number.POSITIVE_INFINITY;
}

export function chooseHopMethod(policy: WarpPolicy, facts: WarpHopFacts): WarpHopChoice {
  if (!policy.enabled) return { method: "gate", reason: "warp tours are switched off in doctrine" };
  if (facts.warpRange === undefined) return { method: "gate", reason: "no warp drive installed" };
  if (facts.knownCruiseNeed === undefined && facts.distance === undefined) {
    return { method: "gate", reason: "distance to the target system isn't known yet" };
  }
  if (facts.distance !== undefined && facts.distance > facts.warpRange) {
    return { method: "gate", reason: `${Math.round(facts.distance)} units away, beyond warp range ${facts.warpRange}` };
  }
  // A need the game reported is exact; an estimate gets the margin.
  const known = facts.knownCruiseNeed !== undefined;
  const cruiseNeed = known
    ? Math.ceil(facts.knownCruiseNeed!)
    : Math.ceil(facts.distance! * policy.fuelPerUnit * policy.fuelMargin);
  const burnNeed = cruiseNeed * WARP_MODE_FUEL_MULTIPLIER.BURN;
  const source = known ? "the game says" : "about";
  if (facts.capacity !== undefined && facts.capacity > 0 && cruiseNeed > facts.capacity) {
    return {
      method: "gate",
      reason: `warp needs ${source} ${cruiseNeed} fuel at cruise, more than the ${facts.capacity} tank holds`,
      fuelNeeded: cruiseNeed,
      distance: facts.distance,
    };
  }
  if (facts.fuel < cruiseNeed) {
    return { method: "gate", reason: `warp needs ${source} ${cruiseNeed} fuel at cruise, has ${facts.fuel}`, fuelNeeded: cruiseNeed, distance: facts.distance };
  }
  // BURN halves the trip but doubles the fuel: only with a quarter tank left over, the same rule as in-system legs
  // (flightMode.ts chooseFlightMode()).
  const reserve = facts.capacity !== undefined && facts.capacity > 0 ? facts.capacity * 0.25 : 0;
  const mode: WarpFlightMode = facts.fuel >= burnNeed && facts.fuel - burnNeed >= reserve ? "BURN" : "CRUISE";
  const need = mode === "BURN" ? burnNeed : cruiseNeed;
  const dist = facts.distance !== undefined ? `${Math.round(facts.distance)} units, ` : "";
  return {
    method: "warp",
    reason: `warp ${dist}${source} ${need} fuel at ${mode.toLowerCase()} of ${facts.fuel}`,
    fuelNeeded: need,
    distance: facts.distance,
    flightMode: mode,
  };
}

/** Key for a learned warp fuel need: one direction between two systems. */
export function warpRouteKey(fromSystem: string, toSystem: string): string {
  return `${fromSystem}>${toSystem}`;
}

/** The shortfall in a rejected warp/navigate message ("... requires 362 more fuel for navigation."), if any. */
export function parseFuelShortfall(message: string): number | undefined {
  const m = /requires\s+(\d+)\s+more\s+fuel/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * The CRUISE fuel a warp needs, from what the game told us. A rejection gives the shortfall at the mode the ship was in
 * (fuel on board + shortfall = need in that mode); a completed warp gives the fuel it burned. Either is converted back
 * to CRUISE, so one number serves both modes.
 */
export function cruiseNeedFromGame(fuelUsedOrNeeded: number, mode: string | undefined): number {
  const mult = mode === "BURN" ? WARP_MODE_FUEL_MULTIPLIER.BURN : WARP_MODE_FUEL_MULTIPLIER.CRUISE;
  return Math.ceil(fuelUsedOrNeeded / mult);
}

/**
 * The waypoint a warp should land on in the target system. A marketplace or shipyard comes first, since a tour ship
 * is there to read prices, then a jump gate, then anything else. Returns undefined when the system has no waypoints.
 */
export function pickWarpArrival(
  waypoints: readonly { symbol: string; traits?: readonly { symbol: string }[]; type?: string }[],
): string | undefined {
  const has = (w: { traits?: readonly { symbol: string }[] }, trait: string): boolean =>
    (w.traits ?? []).some((t) => t.symbol === trait);
  const rank = (w: { traits?: readonly { symbol: string }[]; type?: string }): number => {
    if (has(w, "MARKETPLACE") || has(w, "SHIPYARD")) return 0;
    if (w.type === "JUMP_GATE") return 1;
    return 2;
  };
  let best: { symbol: string; rank: number } | undefined;
  for (const w of waypoints) {
    const r = rank(w);
    if (!best || r < best.rank) best = { symbol: w.symbol, rank: r };
  }
  return best?.symbol;
}
