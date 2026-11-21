/**
 * When the 2-minute "full" state refresh needs the game's own ship list (clause fleetListOnCountChange, 2026-11-21).
 *
 * The refresh in src/engine/tenantRegistry.ts pages through every ship (about 124 pages of 20 for 2,470 ships) every two
 * minutes, but only uses the result for ships the fleet does not already drive (`fleet.currentShips()` is kept current by
 * every action's own response). On 2026-11-21 that list was 37 calls a minute, 23% of the API budget and 18 of 21 429s.
 * The agent read the same refresh already makes carries `shipCount`, so the list is only needed when that count differs
 * from the ships the fleet knows, or as a slow safety net.
 *
 * Pure. `lastListAt` is a cadence mark the caller keeps in memory: after a restart the boot read is a full list anyway, so
 * nothing is lost by forgetting it.
 */

export interface FleetListPolicy {
  enabled: boolean;
  /** List anyway when the last list is older than this (the safety net). */
  safetyMs: number;
}

export interface FleetListInput {
  /** `shipCount` from the agent read; undefined if the read did not carry it. */
  agentShipCount: number | undefined;
  /** Ships the fleet drives now. */
  knownShips: number;
  /** When the ship list was last read (0 = never). */
  lastListAt: number;
  now: number;
}

export interface FleetListDecision {
  list: boolean;
  reason: string;
}

export function needFleetList(input: FleetListInput, policy: FleetListPolicy): FleetListDecision {
  if (!policy.enabled) return { list: true, reason: "clause off: every full refresh lists the ships" };
  if (input.lastListAt <= 0) return { list: true, reason: "no list read yet" };
  if (input.agentShipCount === undefined) return { list: true, reason: "agent read has no ship count" };
  if (input.agentShipCount !== input.knownShips) {
    return { list: true, reason: `game says ${input.agentShipCount} ships, fleet knows ${input.knownShips}` };
  }
  const age = input.now - input.lastListAt;
  if (age >= policy.safetyMs) return { list: true, reason: `last list ${Math.round(age / 60_000)} min old (safety ${Math.round(policy.safetyMs / 60_000)} min)` };
  return { list: false, reason: `ship count matches (${input.knownShips}); last list ${Math.round(age / 60_000)} min old` };
}
