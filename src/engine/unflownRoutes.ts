/**
 * Good routes nobody is flying, how far the nearest trader is, and the nearest yards selling a big hull (operator, 2026-11-20:
 * "keep an eye on that good route from the list ... and what big ships are nearby that can be bought").
 *
 * The board ranks every route at the biggest hold in the fleet; a route at the top can sit unflown because every trader is busy
 * or far away. This lists the best unflown routes with the nearest trader (any, and free), and the closest yards that sell a
 * hull over 80 cargo, with hops and price, so a purchase can be aimed at them. Read-only advice: nothing is bought or moved.
 *
 * Pure: the caller passes the routes, assignments, traders, yards and the gate graph (complete gates only).
 */

export interface UnflownRouteIn {
  good: string;
  buyAt: string;
  buySystem: string;
  sellAt: string;
  sellSystem: string;
  buyPrice: number;
  sellPrice: number;
  profitPerTrip: number;
  profitByHold?: Record<string, number> | null;
  ageMinutes?: number;
}

export interface TraderIn { ship: string; system: string; hold: number; busy: boolean }
export interface YardIn { waypoint: string; system: string; shipType: string; cargo: number; price: number; at: string }

export interface UnflownInput {
  routes: readonly UnflownRouteIn[];
  assignments: readonly { shipSymbol: string; good: string; buyAt?: string; sellAt?: string }[];
  traders: readonly TraderIn[];
  yards: readonly YardIn[];
  /** System -> neighbouring systems through finished gates. */
  adj: ReadonlyMap<string, readonly string[]>;
  limit?: number;
  /** How far to look for a trader or a yard. */
  maxHops?: number;
  /** A hull counts as big above this cargo. */
  bigCargo?: number;
  yardsPerRoute?: number;
}

export interface UnflownRow {
  good: string;
  route: string;
  profitPerTrip: number;
  /** What a 225 / 490 hold would make, when the route list carries it. */
  at225?: number;
  at490?: number;
  ageMinutes?: number;
  nearestTrader?: { ship: string; hops: number; hold: number; busy: boolean };
  nearestFreeTrader?: { ship: string; hops: number; hold: number };
  yards: { yard: string; shipType: string; cargo: number; price: number; hops: number; at: string }[];
  verdict: string;
}

/** Hops from `from` to every system within `maxHops`. */
export function hopsFrom(adj: ReadonlyMap<string, readonly string[]>, from: string, maxHops: number): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    if (d >= maxHops) continue;
    for (const n of adj.get(cur) ?? []) if (!dist.has(n)) { dist.set(n, d + 1); queue.push(n); }
  }
  return dist;
}

/** Cargo of a yard's hull from its fitted cargo modules (the yard's own cargo figure is often 0). */
export function hullCargo(modules: readonly { symbol: string; capacity?: number }[] | null | undefined, listed = 0): number {
  const fromModules = (modules ?? []).filter((m) => m.symbol.includes("CARGO_HOLD")).reduce((t, m) => t + (m.capacity ?? 0), 0);
  return Math.max(fromModules, listed);
}

export function unflownRoutes(input: UnflownInput): UnflownRow[] {
  const limit = input.limit ?? 10;
  const maxHops = input.maxHops ?? 4;
  const bigCargo = input.bigCargo ?? 80;
  const perRoute = input.yardsPerRoute ?? 3;
  const flown = new Set(input.assignments.map((a) => `${a.good}|${a.buyAt}|${a.sellAt}`));
  const bigYards = input.yards.filter((y) => y.cargo > bigCargo);
  // One row per buy market and good: the board lists each sell end separately, but a hull bought for one serves both.
  const seen = new Set<string>();
  const rows: UnflownRow[] = [];
  for (const r of [...input.routes].sort((a, b) => b.profitPerTrip - a.profitPerTrip)) {
    if (rows.length >= limit) break;
    if (r.profitPerTrip <= 0 || flown.has(`${r.good}|${r.buyAt}|${r.sellAt}`)) continue;
    const key = `${r.good}|${r.buyAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dist = hopsFrom(input.adj, r.buySystem, maxHops);
    const near = input.traders
      .filter((t) => dist.has(t.system))
      .map((t) => ({ ...t, hops: dist.get(t.system)! }))
      .sort((a, b) => a.hops - b.hops || b.hold - a.hold);
    const any = near[0];
    const free = near.find((t) => !t.busy);
    const yards = bigYards
      .filter((y) => dist.has(y.system))
      .map((y) => ({ yard: y.waypoint, shipType: y.shipType, cargo: y.cargo, price: y.price, hops: dist.get(y.system)!, at: y.at }))
      .sort((a, b) => a.hops - b.hops || a.price - b.price)
      .slice(0, perRoute);
    const verdict = free && free.hops <= 1
      ? `free trader ${free.ship} is ${free.hops} hop(s) away`
      : any && any.hops === 0
        ? `${any.ship} is in the system but busy`
        : yards.length
          ? `no free trader within 1 hop; nearest big-hull yard ${yards[0]!.yard} (${yards[0]!.hops} hop(s), ${yards[0]!.price.toLocaleString("en-US")})`
          : `no free trader within 1 hop and no big-hull yard within ${maxHops} hops`;
    const hold: Record<string, number> = r.profitByHold ?? {};
    rows.push({
      good: r.good,
      route: `${r.buyAt} -> ${r.sellAt}`,
      profitPerTrip: r.profitPerTrip,
      ...(hold["225"] !== undefined ? { at225: hold["225"] } : {}),
      ...(hold["490"] !== undefined ? { at490: hold["490"] } : {}),
      ...(r.ageMinutes !== undefined ? { ageMinutes: r.ageMinutes } : {}),
      ...(any ? { nearestTrader: { ship: any.ship, hops: any.hops, hold: any.hold, busy: any.busy } } : {}),
      ...(free ? { nearestFreeTrader: { ship: free.ship, hops: free.hops, hold: free.hold } } : {}),
      yards,
      verdict,
    });
  }
  return rows;
}
