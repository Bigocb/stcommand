import type { DispatchExplainSnapshot } from "./dispatchExplain.js";

/**
 * Who is flying a route and, when nobody is, why not: the two facts the Routes board lacked (2026-10-11, the operator
 * could not tell why a high-profit route sat unassigned). Pure: the dashboard hands in the dispatcher's assignments, its
 * last explain snapshot and the sell-market block, and gets one status per route back.
 */
export interface RouteRef {
  good: string;
  buyAt: string;
  sellAt: string;
}

export interface RouteStatus {
  /** Ships whose current assignment is this exact route (good, buy and sell market). */
  flownBy: string[];
  /** Why no ship is on it; null while someone is. */
  reason: string | null;
}

export function routeStatus(
  route: RouteRef,
  assignments: readonly { shipSymbol: string; good: string; buyAt?: string; sellAt?: string; source?: string }[],
  snapshot: DispatchExplainSnapshot | undefined,
  blockedBy: string | undefined,
): RouteStatus {
  const flownBy = assignments
    .filter((a) => a.good === route.good && a.buyAt === route.buyAt && a.sellAt === route.sellAt)
    .map((a) => (a.source === "manual" ? `${a.shipSymbol} (pinned)` : a.shipSymbol));
  if (flownBy.length) return { flownBy, reason: null };
  if (blockedBy) return { flownBy, reason: `sell market blocked: ${blockedBy}` };
  if (!snapshot) return { flownBy, reason: "the dispatcher has not run yet" };

  const item = snapshot.routes.find((r) => r.good === route.good && r.buyAt === route.buyAt && r.sellAt === route.sellAt);
  if (!item) {
    const floor = snapshot.floorDropped.find((r) => r.good === route.good && r.buyAt === route.buyAt && r.sellAt === route.sellAt);
    return { flownBy, reason: floor ? "under the margin floor" : "not on the dispatcher's list (no open gate, or its sell market is already in use)" };
  }
  if (item.claimedBy) return { flownBy, reason: `held for ${item.claimedBy}` };
  // A trader was checked against it and turned it down: report the first reason, counting the rest.
  const reasons: string[] = [];
  for (const t of snapshot.traders) {
    const rej = t.rejected.find((r) => r.key === item.key);
    if (rej) reasons.push(`${t.ship}: ${rej.reason}`);
  }
  if (reasons.length) return { flownBy, reason: reasons.length > 1 ? `${reasons[0]} (+${reasons.length - 1} more)` : reasons[0]! };
  if (snapshot.traders.length > 0 && snapshot.traders.every((t) => t.busy || t.assigned)) return { flownBy, reason: "every trader already has work" };
  return { flownBy, reason: "no trader free for it" };
}

/** Profit per hour of ship time, the dispatcher's own yardstick; null when the route has no trip time (cross-system legs). */
export function ratePerHour(profitPerTrip: number, tripSeconds: number | undefined): number | null {
  return tripSeconds && tripSeconds > 0 ? Math.round((profitPerTrip * 3600) / tripSeconds) : null;
}
