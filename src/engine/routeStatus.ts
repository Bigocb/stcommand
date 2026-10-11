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
  /** Why no ship is on it; null while someone is. For a rejection this is the first trader's. */
  reason: string | null;
  /** The remaining traders' reasons, for the board's "+N more" to open. Empty unless several traders were turned down. */
  more: string[];
  /** The collapsed button's text, e.g. "+2 more" or "ship by ship (3)". Empty when there is nothing to open. */
  moreLabel: string;
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
  if (flownBy.length) return { flownBy, reason: null, more: [], moreLabel: "" };
  if (blockedBy) return { flownBy, reason: `sell market blocked: ${blockedBy}`, more: [], moreLabel: "" };
  if (!snapshot) return { flownBy, reason: "the dispatcher has not run yet", more: [], moreLabel: "" };

  const item = snapshot.routes.find((r) => r.good === route.good && r.buyAt === route.buyAt && r.sellAt === route.sellAt);
  if (!item) {
    const floor = snapshot.floorDropped.find((r) => r.good === route.good && r.buyAt === route.buyAt && r.sellAt === route.sellAt);
    return { flownBy, reason: floor ? "under the margin floor" : "not on the dispatcher's list (no open gate, or its sell market is already in use)", more: [], moreLabel: "" };
  }
  if (item.claimedBy) return { flownBy, reason: `held for ${item.claimedBy}`, more: [], moreLabel: "" };
  // A trader was checked against it and turned it down: report the first reason, counting the rest.
  const reasons: string[] = [];
  for (const t of snapshot.traders) {
    const rej = t.rejected.find((r) => r.key === item.key);
    if (rej) reasons.push(`${t.ship}: ${prettyKeys(rej.reason)}`);
  }
  if (reasons.length) return { flownBy, reason: reasons[0]!, more: reasons.slice(1), moreLabel: reasons.length > 1 ? `+${reasons.length - 1} more` : "" };
  if (snapshot.traders.length > 0 && snapshot.traders.every((t) => t.busy || t.assigned)) {
    // Say what each one is doing: cargo aboard means mid-trip (it is re-assigned once the hold is sold), a pin stays until released.
    const what = snapshot.traders.map((t) => {
      const mine = assignments.find((a) => a.shipSymbol === t.ship);
      if (mine?.source === "manual") return `${t.ship} pinned to ${mine.good}`;
      if (t.busy) return `${t.ship} mid-trip with cargo${mine ? ` (${mine.good})` : ""}`;
      return `${t.ship} on ${mine?.good ?? t.assigned ?? "another route"}`;
    });
    return { flownBy, reason: "every trader is occupied", more: what, moreLabel: `ship by ship (${what.length})` };
  }
  return { flownBy, reason: "no trader free for it", more: [], moreLabel: "" };
}

/**
 * The dispatcher names work by internal key in its reasons ("outscored by EQUIPMENT:contractBuy",
 * "outscored by FERTILIZERS@X1-CM13-K100"). Say what those are: a contract delivery, a warehouse buy, a route into one market.
 */
export function prettyKeys(text: string): string {
  return text
    .replace(/\b([A-Z][A-Z_]+):contractBuy\b/g, "$1 contract delivery")
    .replace(/\b([A-Z][A-Z_]+):buy\b/g, "$1 warehouse buy")
    .replace(/\b([A-Z][A-Z_]+):sell\b/g, "$1 warehouse sell")
    .replace(/\b([A-Z][A-Z_]+):haul\b/g, "$1 mission haul")
    .replace(/\b([A-Z][A-Z_]+)@X1-[A-Z0-9]+-([A-Z0-9]+)\b/g, "$1 into $2");
}

/** Profit per hour of ship time, the dispatcher's own yardstick; null when the route has no trip time (cross-system legs). */
export function ratePerHour(profitPerTrip: number, tripSeconds: number | undefined): number | null {
  return tripSeconds && tripSeconds > 0 ? Math.round((profitPerTrip * 3600) / tripSeconds) : null;
}
