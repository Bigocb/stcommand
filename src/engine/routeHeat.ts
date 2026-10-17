/**
 * Route cool-off: a route whose last trip made far less than it promised (or lost money) rests for a while.
 *
 * 2026-10-17, THEOREM-55 ran FABRICS EC8X > FC9E four times in four minutes with ~490-unit holds. Its own buying
 * pushed the buy price 1878 -> 2319 and its own selling pushed the sell price 2226 -> 1680, and one trip lost 161k.
 * The sell-volume discount and the loss floor both react after the damage; a market needs about 30 minutes to
 * recover, so the honest response to a trip that disappointed is to leave that exact route alone until then.
 *
 * Pure: the caller passes the closed trips it has seen and the clock. `minutes` 0 switches it off.
 */

export interface RouteTrip {
  good: string;
  buyAt: string;
  sellAt: string;
  /** What the trip was planned to earn, credits. */
  promised: number;
  /** What it actually earned (revenue minus cost), credits. */
  made: number;
  /** When it closed, ms. */
  at: number;
}

export interface HeatPolicy {
  /** How long a disappointing route rests; 0 = off. */
  minutes: number;
  /** A trip that made less than this share of its promise is disappointing. */
  minShare: number;
}

export const DEFAULT_HEAT_POLICY: HeatPolicy = { minutes: 30, minShare: 0.4 };

export const routeKey = (good: string, buyAt: string, sellAt: string): string => `${good}|${buyAt}|${sellAt}`;

/** Did this trip fall short enough to rest its route? A trip with no promise on record never counts. */
export function disappointed(t: Pick<RouteTrip, "promised" | "made">, policy: HeatPolicy): boolean {
  if (!(t.promised > 0)) return false;
  return t.made < t.promised * policy.minShare;
}

/** Why this route should rest now, or undefined when it is open. Only the most recent trip on the route counts. */
export function coolOffReason(trips: readonly RouteTrip[], good: string, buyAt: string, sellAt: string, now: number, policy: HeatPolicy): string | undefined {
  if (!(policy.minutes > 0)) return undefined;
  let last: RouteTrip | undefined;
  for (const t of trips) if (t.good === good && t.buyAt === buyAt && t.sellAt === sellAt && (!last || t.at > last.at)) last = t;
  if (!last || !disappointed(last, policy)) return undefined;
  const leftMin = (last.at + policy.minutes * 60_000 - now) / 60_000;
  if (leftMin <= 0) return undefined;
  const made = Math.round(last.made), promised = Math.round(last.promised);
  return `resting ${Math.ceil(leftMin)} more min: last trip made ${made}c against ${promised}c promised`;
}
