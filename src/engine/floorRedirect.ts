/**
 * Where to take cargo that is stuck below its loss floor at the market it was bound for.
 *
 * Pure: the caller passes the price table and what it can reach. 2026-10-10: THEO-85 (a 490-unit freighter) sat at
 * MC94-EB3F for minutes holding 180u EQUIPMENT because the destination's price had fallen to 2146c against a cost of
 * 2767c, while other markets paid 3,600c+. The trader only ever held, so the biggest hull in the fleet idled. This picks
 * another market that clears the floor so the ship can carry on.
 */

export interface FloorRedirectInput {
  good: string;
  /** Market the ship is at now (and cannot sell at). */
  here: string;
  /** Cost basis per unit and the allowed loss, as the trader's own floor uses them. */
  cost: number;
  maxLossPct: number;
  /** Observed sell prices: waypoint -> price the market pays. */
  prices: ReadonlyMap<string, number>;
  /** Markets already tried for this lot; never offered again. */
  tried: ReadonlySet<string>;
  systemOf(waypoint: string): string;
  /** True when a leg from the ship's system to this one can be flown. */
  reachable(system: string): boolean;
}

export interface FloorRedirect { waypoint: string; price: number; reason: string }

export function pickFloorRedirect(i: FloorRedirectInput): FloorRedirect | undefined {
  const floor = i.cost * (1 - i.maxLossPct / 100);
  let best: FloorRedirect | undefined;
  for (const [wp, price] of i.prices) {
    if (wp === i.here || i.tried.has(wp) || price < floor || !i.reachable(i.systemOf(wp))) continue;
    if (!best || price > best.price) best = { waypoint: wp, price, reason: "" };
  }
  if (best) best.reason = `${i.good}: ${i.here} is below the floor (${Math.round(floor)}c); ${best.waypoint} paid ${best.price}c`;
  return best;
}
