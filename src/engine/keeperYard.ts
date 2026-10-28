/**
 * Which shipyard a keeper hull should be bought at: the cheapest one in the
 * system. Shipyard prices swing a lot between yards (MG54, 2026-10-09: probes
 * 55,589 at C38 and 124,017 at A2), so nearest-yard-wins overpaid by 2x.
 *
 * Only rows seen within `freshMs` count, since a price from hours ago is a
 * guess. If no keeper hull has a fresh row anywhere in the system, fall back
 * to every row rather than propose nothing: a yard is only scanned when a ship
 * visits it.
 */
export interface KeeperYardRow {
  systemSymbol: string;
  waypointSymbol: string;
  shipType: string;
  purchasePrice: number;
  timestamp: string;
}

export const KEEPER_YARD_FRESH_MS = 10 * 60_000;

export function pickCheapestKeeperYard<T extends KeeperYardRow>(
  rows: readonly T[],
  opts: { systemSymbol: string; hulls: readonly string[]; nowMs: number; freshMs?: number; distance?: (waypoint: string) => number },
): T | undefined {
  const freshMs = opts.freshMs ?? KEEPER_YARD_FRESH_MS;
  const eligible = rows.filter((r) => r.systemSymbol === opts.systemSymbol && opts.hulls.includes(r.shipType));
  const fresh = eligible.filter((r) => opts.nowMs - Date.parse(r.timestamp) <= freshMs);
  const pool = fresh.length ? fresh : eligible;
  let best: T | undefined;
  for (const r of pool) {
    if (!best) { best = r; continue; }
    if (r.purchasePrice !== best.purchasePrice) {
      if (r.purchasePrice < best.purchasePrice) best = r;
      continue;
    }
    // Same price: the nearer yard.
    if (opts.distance && opts.distance(r.waypointSymbol) < opts.distance(best.waypointSymbol)) best = r;
  }
  return best;
}

/**
 * The yard to buy a keeper through when the cheapest one has none of our ships at it: the best yard in the system where one of ours
 * already is. Hull preference still comes first (probe, then surveyor, then drones), price decides within a hull. A keeper stationed
 * at any yard of the system can buy for the rest of it, so the batch need not wait for a ship to dock at the cheapest yard.
 *
 * Only a fallback: the caller tries the cheapest yard first, since a cheaper yard saves real credits across a whole system.
 */
export function pickKeeperYardWithShip<T extends KeeperYardRow>(
  rows: readonly T[],
  opts: { systemSymbol: string; hulls: readonly string[]; nowMs: number; freshMs?: number; distance?: (waypoint: string) => number; shipPresentAt: (waypoint: string) => boolean },
): T | undefined {
  const here = rows.filter((r) => opts.shipPresentAt(r.waypointSymbol));
  for (const hull of opts.hulls) {
    const pick = pickCheapestKeeperYard(here, { systemSymbol: opts.systemSymbol, hulls: [hull], nowMs: opts.nowMs, freshMs: opts.freshMs, distance: opts.distance });
    if (pick) return pick;
  }
  return undefined;
}
