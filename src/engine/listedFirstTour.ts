/**
 * Listed-first touring (clause stagedTourListedFirst, operator idea 2026-11-19).
 *
 * A staged system is released by the tour path once a tour ship is in it and releaseOnTourPct of its LISTED markets (the ones
 * picked for keepers when it was queued) have been priced. A normal tour visits every market in the system, stale first then
 * nearest, so it can spend hours on markets that do not count before it reaches the ones that do. In listed-first mode the
 * tour visits only the listed markets that have never been priced; once none is left it goes back to the normal tour.
 *
 * Pure: the caller supplies the system's listed-and-unpriced markets and this ship's position. No I/O, no clock.
 */

export type ListedFirstPick = {
  /** The markets to choose the next leg from: the listed, never-priced ones in this system, not counting where the ship stands. */
  targets: string[];
  /** One line for the log. */
  reason: string;
};

/** The waypoint's system: everything before the last dash (X1-ZU90-CC7Z -> X1-ZU90). */
const systemOf = (waypoint: string): string => waypoint.slice(0, waypoint.lastIndexOf("-"));

/**
 * The listed-first targets for a ship touring `system` from `here`, or undefined to tour normally.
 * `listedUnpriced` is the system's listed markets with no price on record (an empty list, or the clause off, means tour normally).
 * Markets outside `system` are ignored: a tour leg never crosses a gate.
 */
export function listedFirstTargets(system: string, here: string, listedUnpriced: readonly string[]): ListedFirstPick | undefined {
  const targets = [...new Set(listedUnpriced)].filter((m) => m !== here && systemOf(m) === system).sort();
  if (!targets.length) return undefined;
  return { targets, reason: `listed-first: ${targets.length} listed market(s) in ${system} not yet priced (${targets.join(", ")})` };
}
