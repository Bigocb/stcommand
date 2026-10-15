/**
 * The parts of a ship that change while it flies and trades (where it is, fuel, cargo, cooldown), and a diff between
 * two moments, so the live feed sends only the ships that changed.
 *
 * Pure. The static parts (frame, modules, mounts, crew) still come with the state snapshot; a screen applies a row by
 * replacing those four fields on the ship it already has.
 */
import type { Ship } from "./state.js";

/** A route end as the screens use it: which waypoint, and where it is (the map draws a ship between the two). */
export interface RouteEnd {
  symbol: string;
  x: number;
  y: number;
}

/**
 * The live parts of a ship, trimmed to what the screens read. Left out: a cargo item's name and description (the
 * screen keeps them from the ship it already has), a route end's type and system, the fuel-consumption record and
 * the cooldown's ship symbol. That is about a third of the full objects' size.
 */
export interface ShipRow {
  symbol: string;
  nav: {
    status: Ship["nav"]["status"];
    flightMode: Ship["nav"]["flightMode"];
    systemSymbol: string;
    waypointSymbol: string;
    route?: { origin?: RouteEnd; destination?: RouteEnd; departureTime?: string; arrival?: string };
  };
  fuel: { current: number; capacity: number };
  cargo: { capacity: number; units: number; inventory: { symbol: string; units: number }[] };
  cooldown?: { totalSeconds: number; remainingSeconds: number; expiration?: string };
}

const end = (w: { symbol: string; x: number; y: number } | undefined): RouteEnd | undefined => (w ? { symbol: w.symbol, x: w.x, y: w.y } : undefined);

export function shipRow(s: Ship): ShipRow {
  const r = s.nav?.route;
  return {
    symbol: s.symbol,
    nav: {
      status: s.nav?.status,
      flightMode: s.nav?.flightMode,
      systemSymbol: s.nav?.systemSymbol,
      waypointSymbol: s.nav?.waypointSymbol,
      route: r ? { origin: end(r.origin), destination: end(r.destination), departureTime: r.departureTime, arrival: r.arrival } : undefined,
    },
    fuel: { current: s.fuel?.current ?? 0, capacity: s.fuel?.capacity ?? 0 },
    cargo: { capacity: s.cargo?.capacity ?? 0, units: s.cargo?.units ?? 0, inventory: (s.cargo?.inventory ?? []).map((i) => ({ symbol: i.symbol, units: i.units })) },
    cooldown: s.cooldown ? { totalSeconds: s.cooldown.totalSeconds, remainingSeconds: s.cooldown.remainingSeconds, expiration: s.cooldown.expiration } : undefined,
  };
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
