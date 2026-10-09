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
