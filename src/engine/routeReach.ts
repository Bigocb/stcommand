/**
 * Whether any trader of ours can get to a route at all, for the route board.
 *
 * Prices can come from ships we do not run (another agent's keepers write the same galaxy-wide market tables), so a system
 * can show routes our traders cannot fly: 2026-10-28, X1-PK42's gate was unfinished and its JEWELRY route led the board at
 * 4M/h. The dispatcher already refuses to send a ship (its own per-trader check); the board did not use that answer. This is
 * the same question asked once for the whole fleet: is the route's buy system a system a trader is in, or one it can fly to?
 *
 * Pure: the caller supplies the trader systems and the reachability test. Null = reachable (or nothing to judge on).
 */
export interface RouteReachInput {
  buySystem: string;
  sellSystem: string;
}

export function routeUnreachableReason(
  route: RouteReachInput,
  traderSystems: ReadonlySet<string>,
  canFly: (from: string, to: string) => boolean,
): string | null {
  if (traderSystems.size === 0) return null;
  for (const from of traderSystems) {
    if (from === route.buySystem || canFly(from, route.buySystem)) return null;
  }
  const from = [...traderSystems].join(", ");
  return `no trader can reach ${route.buySystem}: no finished gate path from ${from}`;
}
