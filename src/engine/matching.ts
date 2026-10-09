/**
 * Route-first matching: give the best routes to the ships best placed to run them.
 *
 * The dispatcher walks its idle traders biggest hold first and hands each the best route it can reach, so who gets a
 * route is decided by hold size alone: a 150-hold ship far from a rich route takes it ahead of an 80-hold ship standing
 * at its buy market, and a 40-hold ship may be handed a route that would have paid several times more on a bigger hull.
 * This module reverses the question for the top few routes: for each, which idle ship would earn the most from it,
 * counting the hold it flies and the time it spends getting to the buy market?
 *
 * It only decides the ORDER ships are served in. The dispatcher still scores, reserves and assigns exactly as before
 * (circuits, follow-ons, fuel, impact), it just starts with the ships this module picked, in that order, so each ship's
 * own first choice is the route it was matched to. With `topN` 0 no ship is ordered and nothing changes.
 *
 * Pure: no I/O, no clock, no globals. What the caller knows (can this ship take this route, how long until it can start
 * buying) comes in through `MatchContext`. Policy is data (`MatchPolicy`), backed by a doctrine clause.
 */

export interface MatchPolicy {
  /** How many of the best routes are matched, in rank order. 0 switches the feature off. */
  topN: number;
}

export const DEFAULT_MATCH_POLICY: MatchPolicy = { topN: 0 };

export interface MatchItem {
  key: string;
  /** The rank figure the dispatcher sorts on (already decayed for market fatigue). */
  profitPerTrip: number;
  /** The route's undecayed profit at the biggest hold; the denominator for `profitByHold`. */
  rawProfit?: number;
  /** The same trip priced at each hold size flying (hold units as a string -> credits). */
  profitByHold?: Record<string, number>;
  /** Units the trip can move at most; the fallback when `profitByHold` has no entry for a hold. */
  volume?: number;
  /** One-way trip seconds, to turn positioning time into a share of the trip. */
  tripSeconds?: number;
}

export interface MatchShip {
  shipSymbol: string;
  capacity: number;
}

export interface MatchContext {
  /** Seconds until this ship could start buying for this route, or undefined when it cannot take it at all. */
  positioningSeconds: (ship: MatchShip, item: MatchItem) => number | undefined;
}

export interface MatchResult {
  /** Matched ships, in the order they should be served: best route's ship first. */
  order: string[];
  /** One line per match, for the dispatch log. */
  notes: string[];
}

/** What this ship would earn from this route: its hold's share of the profit, less the time spent getting there. */
export function fitValue(item: MatchItem, ship: MatchShip, positioningSeconds: number): number {
  const exact = item.profitByHold?.[String(ship.capacity)];
  let share: number;
  if (exact !== undefined && item.rawProfit !== undefined && item.rawProfit > 0) share = exact / item.rawProfit;
  else if (item.volume !== undefined && item.volume > 0) share = ship.capacity / item.volume;
  else share = 1;
  share = Math.min(1, Math.max(0, share));
  const trip = item.tripSeconds;
  const timeScale = trip && trip > 0 ? trip / (trip + Math.max(0, positioningSeconds)) : 1;
  return item.profitPerTrip * share * timeScale;
}

/**
 * Walk the best `topN` routes in the order given (the caller passes them best first) and pick for each the unmatched
 * ship with the highest `fitValue`. A tie goes to the bigger hold. Routes nobody can take are skipped.
 */
export function matchShips(items: readonly MatchItem[], ships: readonly MatchShip[], ctx: MatchContext, policy: MatchPolicy): MatchResult {
  const result: MatchResult = { order: [], notes: [] };
  if (policy.topN <= 0) return result;
  const free = new Map(ships.map((s) => [s.shipSymbol, s]));
  for (const item of items.slice(0, policy.topN)) {
    const scored: { ship: MatchShip; value: number }[] = [];
    for (const ship of free.values()) {
      const pos = ctx.positioningSeconds(ship, item);
      if (pos === undefined) continue;
      scored.push({ ship, value: fitValue(item, ship, pos) });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.value - a.value || b.ship.capacity - a.ship.capacity);
    const best = scored[0]!;
    const next = scored[1];
    free.delete(best.ship.shipSymbol);
    result.order.push(best.ship.shipSymbol);
    result.notes.push(
      `dispatch match: ${item.key} -> ${best.ship.shipSymbol} (${best.ship.capacity}u, worth ${Math.round(best.value)})` +
        (next ? `, next ${next.ship.shipSymbol} (${next.ship.capacity}u, ${Math.round(next.value)})` : ", no other ship can take it"),
    );
  }
  return result;
}
