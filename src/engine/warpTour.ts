/**
 * Warp tours: how a tour ship crosses to another system when it has a warp drive, instead of walking the gate graph.
 *
 * Pure. The caller (FleetManager.hopToward()) fills in the ship's warp range and fuel, the distance to the target
 * system and the policy, and acts on the answer. Warping skips the gate entirely: no jump cost, no gate cooldown, and
 * no need for the target system's gate to be finished. Anything that can't warp falls back to the gate path unchanged.
 */

export type HopMethod = "warp" | "gate";

export interface WarpPolicy {
  /** Doctrine clause toggle. Off means every hop goes through a gate, as before. */
  enabled: boolean;
  /**
   * Fuel units assumed per galaxy distance unit. UNVERIFIED against the live API: the first real warp logs the fuel it
   * actually cost (see FleetManager.warpToward()), so recalibrate this from that. Errs high on purpose, so a warp is
   * never attempted on a tank that might run dry mid-flight.
   */
  fuelPerUnit: number;
  /** Multiplier on the estimate, so a ship only warps with spare fuel left over. */
  fuelMargin: number;
}

export const DEFAULT_WARP_POLICY: WarpPolicy = { enabled: true, fuelPerUnit: 1, fuelMargin: 1.2 };

export interface WarpHopFacts {
  /** Range of the installed warp drive module, or undefined when the ship has no warp drive. */
  warpRange?: number;
  /** Current fuel units. */
  fuel: number;
  /** Galaxy distance from the ship's system to the target system, or undefined when not yet known. */
  distance?: number;
}

export interface WarpHopChoice {
  method: HopMethod;
  /** One line for the log, saying why this method was picked. */
  reason: string;
  /** Estimated fuel the warp needs (undefined when it wasn't computed). */
  fuelNeeded?: number;
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
  if (facts.distance === undefined) return { method: "gate", reason: "distance to the target system isn't known yet" };
  if (facts.distance > facts.warpRange) {
    return { method: "gate", reason: `${Math.round(facts.distance)} units away, beyond warp range ${facts.warpRange}` };
  }
  const fuelNeeded = Math.ceil(facts.distance * policy.fuelPerUnit * policy.fuelMargin);
  if (facts.fuel < fuelNeeded) {
    return { method: "gate", reason: `warp needs about ${fuelNeeded} fuel, has ${facts.fuel}`, fuelNeeded };
  }
  return {
    method: "warp",
    reason: `warp ${Math.round(facts.distance)} units (about ${fuelNeeded} fuel of ${facts.fuel})`,
    fuelNeeded,
  };
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
