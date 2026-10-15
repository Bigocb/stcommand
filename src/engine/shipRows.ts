/**
 * The parts of a ship that change while it flies and trades (where it is, fuel, cargo, cooldown), and a diff between
 * two moments, so the live feed sends only the ships that changed.
 *
 * Pure. The static parts (frame, modules, mounts, crew) still come with the state snapshot; a screen applies a row by
 * replacing those four fields on the ship it already has.
 */
import type { Ship } from "./state.js";

export interface ShipRow {
  symbol: string;
  nav: Ship["nav"];
  fuel: Ship["fuel"];
  cargo: Ship["cargo"];
  cooldown: Ship["cooldown"];
}

export function shipRow(s: Ship): ShipRow {
  return { symbol: s.symbol, nav: s.nav, fuel: s.fuel, cargo: s.cargo, cooldown: s.cooldown };
}

/** What a screen needs to apply: rows that are new or changed, and ships that are gone. */
export interface ShipDiff {
  changed: ShipRow[];
  removed: string[];
}

/**
 * Compare the ships now with the last rows sent (`last`, keyed by symbol, as JSON). Returns the diff and the new
 * `last` to keep. A cooldown's `remainingSeconds` counts down by itself, so it's left out of the comparison: the
 * screen works from the absolute `expiration`, which only changes when a new cooldown starts.
 */
export function diffShips(last: ReadonlyMap<string, string>, ships: readonly Ship[]): { diff: ShipDiff; next: Map<string, string> } {
  const next = new Map<string, string>();
  const changed: ShipRow[] = [];
  for (const s of ships) {
    const row = shipRow(s);
    const key = JSON.stringify({ ...row, cooldown: row.cooldown ? { ...row.cooldown, remainingSeconds: undefined } : row.cooldown });
    next.set(s.symbol, key);
    if (last.get(s.symbol) !== key) changed.push(row);
  }
  const removed = [...last.keys()].filter((sym) => !next.has(sym));
  return { diff: { changed, removed }, next };
}
