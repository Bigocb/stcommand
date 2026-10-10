/**
 * What the route dispatcher saw on its last cycle, and why each route did or did
 * not go to each idle trader (ops tool `dispatch_explain`, docs/ops-layer-design.md).
 *
 * Pure: the dispatcher fills a snapshot at the end of recompute(); this module only
 * shapes and filters one for a reader. No I/O, no clock.
 */

/** A work item as the dispatcher ranked it this cycle. `key` is the work key (`GOOD`, `GOOD@sellAt`, `GOOD:buy`, ...). */
export interface ExplainRoute {
  key: string;
  good: string;
  buyAt?: string;
  sellAt?: string;
  buySystem?: string;
  /** Raw profit per trip as the route list stated it. */
  profitPerTrip: number;
  /** Score used for ranking, after market-fatigue and positioning discounts. */
  score: number;
  /** The ship holding this route at the end of the cycle, if any. */
  claimedBy?: string;
}

/** One route one idle trader was refused, with the reason in plain words. */
export interface ExplainRejection {
  key: string;
  good: string;
  sellAt?: string;
  reason: string;
}

export interface ExplainTrader {
  ship: string;
  system?: string;
  waypoint?: string;
  busy: boolean;
  /** The work key this trader was assigned this cycle, if any. */
  assigned?: string;
  /** Every route this trader was checked against (idle traders only), one reason each. */
  rejected: ExplainRejection[];
}

export interface DispatchExplainSnapshot {
  /** Epoch ms of the recompute that produced this. */
  at: number;
  routes: ExplainRoute[];
  /** Routes dropped before the trader loop because their margin is at or under the floor. */
  floorDropped: ExplainRoute[];
  traders: ExplainTrader[];
}

export interface ExplainFilter {
  ship?: string;
  good?: string;
  limit?: number;
}

/** The good a work key is about: `FUEL@X1-A` -> FUEL, `FUEL:buy` -> FUEL, `FUEL` -> FUEL. */
export function goodOfKey(key: string): string {
  return key.split(/[@:]/)[0] ?? key;
}

/**
 * Narrow the snapshot to one ship and/or one good. With no filter it returns the top routes
 * and a per-trader summary (rejection counts only), so the default answer stays small.
 */
export function selectExplain(snap: DispatchExplainSnapshot, f: ExplainFilter = {}) {
  const limit = Math.max(1, f.limit ?? 30);
  const matchesGood = (good: string) => f.good === undefined || good === f.good;

  const routes = snap.routes.filter((r) => matchesGood(r.good));
  const floorDropped = snap.floorDropped.filter((r) => matchesGood(r.good));

  let traders = snap.traders;
  if (f.ship !== undefined) traders = traders.filter((t) => t.ship === f.ship);
  if (f.good !== undefined) {
    traders = traders.filter((t) =>
      (t.assigned !== undefined && goodOfKey(t.assigned) === f.good) || t.rejected.some((r) => r.good === f.good));
  }
  const detailed = f.ship !== undefined || f.good !== undefined;

  return {
    asOf: snap.at,
    routes: routes.slice(0, limit),
    routeCount: routes.length,
    floorDropped: floorDropped.slice(0, limit),
    traders: traders.slice(0, limit).map((t) => {
      const rejected = detailed ? t.rejected.filter((r) => matchesGood(r.good)).slice(0, limit) : [];
      return {
        ship: t.ship,
        system: t.system,
        waypoint: t.waypoint,
        busy: t.busy,
        assigned: t.assigned,
        rejectedCount: t.rejected.length,
        rejected,
      };
    }),
    traderCount: traders.length,
  };
}
