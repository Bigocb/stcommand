// Fleet-wide trading tempo from the ledger: per time bucket, how many trips started and finished, how many ships
// traded, how many were travelling (a JUMP row), and how many known traders left no row at all. Pure.
//
// Why: an hourly profit dip can come from fewer trips starting (ships bunched in transit, a stalled loop) or from
// worse prices per trip. This separates the two. A bucket with ships travelling and few trades is bunching; a bucket
// with silent ships and no jumps is ships waiting on something. Read next to market_spread and profit per hour.

import type { LedgerRow } from "./metrics.js";

export interface TempoBucket {
  /** Bucket start, ISO. */
  from: string;
  /** Trips started: purchase bursts (same ship, good and waypoint within 15 s count once). */
  tripsStarted: number;
  /** Sell bursts (same ship, good and waypoint within 15 s count once). */
  tripsEnded: number;
  /** Ships that bought or sold in the bucket. */
  tradingShips: number;
  /** Ships with a JUMP row and no trade in the bucket: travelling. */
  travellingShips: number;
  /** Known traders with no ledger row of any kind in the bucket. */
  silentShips: number;
  purchaseValue: number;
  sellValue: number;
  /** Realized profit of the bucket's sells. */
  matchedProfit: number;
}

export interface TradeTempo {
  bucketMin: number;
  /** Ships that traded at least once in the window; the base for silentShips. */
  knownTraders: number;
  buckets: TempoBucket[];
  note: string;
}

const BURST_MS = 15_000;

export function tradeTempo(rows: LedgerRow[], opts: { sinceMs: number; nowMs: number; bucketMin?: number }): TradeTempo {
  const bucketMin = Math.max(1, opts.bucketMin ?? 5);
  const size = bucketMin * 60_000;
  const sorted = rows.filter((r) => r.ts >= opts.sinceMs && r.ts <= opts.nowMs).sort((a, b) => a.ts - b.ts);
  const traders = new Set(sorted.filter((r) => (r.type === "PURCHASE" || r.type === "SELL") && r.good).map((r) => r.ship));

  interface Acc { buys: number; sells: number; trading: Set<string>; jumping: Set<string>; any: Set<string>; pv: number; sv: number; pnl: number }
  const acc = new Map<number, Acc>();
  const lastBurst = new Map<string, number>();
  for (const r of sorted) {
    if (!traders.has(r.ship)) continue;
    const key = Math.floor(r.ts / size) * size;
    let a = acc.get(key);
    if (!a) { a = { buys: 0, sells: 0, trading: new Set(), jumping: new Set(), any: new Set(), pv: 0, sv: 0, pnl: 0 }; acc.set(key, a); }
    a.any.add(r.ship);
    if (r.type === "JUMP") a.jumping.add(r.ship);
    if ((r.type !== "PURCHASE" && r.type !== "SELL") || !r.good) continue;
    a.trading.add(r.ship);
    const burstKey = `${r.type}|${r.ship}|${r.good}|${r.waypoint}`;
    const prev = lastBurst.get(burstKey);
    const fresh = prev === undefined || r.ts - prev > BURST_MS;
    lastBurst.set(burstKey, r.ts);
    if (r.type === "PURCHASE") {
      if (fresh) a.buys += 1;
      a.pv += r.total;
    } else {
      if (fresh) a.sells += 1;
      a.sv += r.total;
      a.pnl += r.pnl ?? 0;
    }
  }
  const buckets: TempoBucket[] = [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([start, a]) => ({
      from: new Date(start).toISOString(),
      tripsStarted: a.buys,
      tripsEnded: a.sells,
      tradingShips: a.trading.size,
      travellingShips: [...a.jumping].filter((s) => !a.trading.has(s)).length,
      silentShips: Math.max(0, traders.size - a.any.size),
      purchaseValue: Math.round(a.pv),
      sellValue: Math.round(a.sv),
      matchedProfit: Math.round(a.pnl),
    }));
  return {
    bucketMin,
    knownTraders: traders.size,
    buckets,
    note: "tripsStarted/tripsEnded count bursts of same-ship, same-good, same-waypoint rows once. travellingShips jumped without trading in the bucket; silentShips left no ledger row (in a long flight, or waiting). knownTraders are ships that traded at least once in the window.",
  };
}
