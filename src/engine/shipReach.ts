/**
 * Ship reach: whether a trader may leave its own system to trade.
 *
 * `any` is the default and what every ship does today. `system` is for a local ship: it only takes routes whose buy
 * and sell markets are both in the system it sits in, so it never flies a gate, never pays positioning, and never
 * competes with the cross-system fleet for those routes. The dispatcher also hands cross-system routes out first and
 * gives local ships what is left, so a local assignment never takes a cross-system route away.
 *
 * Pure. No I/O. The fleet persists the map (fleet flag `shipReach`) and passes each ship's reach into the dispatcher and
 * the trader as a plain value. Setting a ship back to `any` removes its entry.
 */

export type ShipReach = "any" | "system";

export const SHIP_REACHES: readonly ShipReach[] = ["any", "system"];

/** Validate operator input. "any", null, undefined or "" all mean the default (no entry). Throws on anything else. */
export function normalizeShipReach(input: unknown): ShipReach | undefined {
  if (input === undefined || input === null || input === "" || input === "any") return undefined;
  if (input === "system") return "system";
  throw new Error(`reach must be "system" (local only) or "any" (default), got ${JSON.stringify(input)}`);
}

/** The system a waypoint symbol belongs to, e.g. X1-CM13-A2 -> X1-CM13. */
export function systemOfWaypoint(waypoint: string): string {
  return waypoint.slice(0, waypoint.lastIndexOf("-"));
}

/**
 * Why a route is outside a ship's reach, or undefined when the ship may take it. A `system` ship needs both markets in
 * its own system; a route whose buy system is unknown is refused, since it can't be shown to be local.
 */
export function routeOutsideReach(
  reach: ShipReach | undefined,
  shipSystem: string | undefined,
  route: { buySystem?: string; sellSystem?: string },
): string | undefined {
  if (reach !== "system") return undefined;
  if (shipSystem === undefined) return "a local-only ship with no known system";
  if (route.buySystem === undefined) return "a local-only ship, and the route's buy system is unknown";
  if (route.buySystem !== shipSystem) return `a local-only ship in ${shipSystem} cannot buy in ${route.buySystem}`;
  if (route.sellSystem !== undefined && route.sellSystem !== shipSystem) return `a local-only ship cannot sell in ${route.sellSystem}`;
  return undefined;
}
