/**
 * Save and restore the dispatcher's trip history (closed trips and trip starts) across a restart.
 *
 * The route limits read this history: the cool-off (routeHeat.ts), the round limits (routeRounds.ts) and trip spacing
 * (tripSpacing.ts). It lived only in memory, so every deploy reset them. 2026-11-19: THEO-33 ran IRON UU52-EX7A > F12C
 * at 13:09 and 13:12 (route resting until about 14:09), the 13:33 deploy cleared the count, and it ran the route again
 * at 13:39 and 13:41; ALUMINUM EX7A > ZD6C rested at 13:29 and ran again at 13:48.
 *
 * Pure: no I/O, no clock (the caller passes `now`). Rows outside the keep window and malformed rows are skipped.
 */

import type { RouteTrip } from "./routeHeat.js";
import type { TripStart } from "./tripSpacing.js";

/** Rows older than this are not worth keeping: every limit looks back at most a few hours. Matches the dispatcher's own pruning. */
export const TRIP_HISTORY_KEEP_MS = 6 * 3_600_000;
/** Most rows of each kind kept (the dispatcher keeps 200). */
export const TRIP_HISTORY_MAX = 200;

/** A trader's declined leg, kept off its picks until `until` (RouteDispatcher.decline). */
export interface DeclinedLeg { good: string; buyAt?: string; sellAt?: string; wholeGood: boolean; until: number }
/** Units we sold into one (good@market), for the sell-side fatigue in route scoring (RouteDispatcher.recordSale). */
export interface RecentSale { units: number; at: number }

/**
 * Everything the dispatcher decides from that is not already saved elsewhere. Operator rule (2026-11-19, repeated): nothing
 * that a decision depends on may live only in memory. `sales` and `declined` are optional so an older saved flag still loads.
 */
export interface TripHistory {
  trips: RouteTrip[];
  starts: TripStart[];
  sales?: [string, RecentSale[]][];
  declined?: [string, DeclinedLeg][];
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/** JSON for the history, newest rows kept, sorted by time. */
export function packTripHistory(h: TripHistory, now: number): string {
  const since = now - TRIP_HISTORY_KEEP_MS;
  const trips = h.trips.filter((t) => t.at >= since).slice(-TRIP_HISTORY_MAX);
  const starts = h.starts.filter((s) => s.at >= since).slice(-TRIP_HISTORY_MAX);
  const sales = (h.sales ?? []).map(([k, list]) => [k, list.filter((x) => x.at >= since).slice(-TRIP_HISTORY_MAX)] as [string, RecentSale[]]).filter(([, l]) => l.length > 0);
  const declined = (h.declined ?? []).filter(([, d]) => d.until > now);
  return JSON.stringify({ trips, starts, sales, declined });
}

/** Parse saved history; bad JSON gives an empty history. */
export function unpackTripHistory(json: string, now: number): TripHistory {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { trips: [], starts: [] }; }
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as { trips?: unknown; starts?: unknown };
  const since = now - TRIP_HISTORY_KEEP_MS;
  const trips: RouteTrip[] = [];
  for (const r of Array.isArray(o.trips) ? o.trips : []) {
    const t = r as Partial<RouteTrip>;
    if (!isStr(t.good) || !isStr(t.buyAt) || !isStr(t.sellAt) || !isNum(t.promised) || !isNum(t.made) || !isNum(t.at) || t.at < since || t.at > now) continue;
    trips.push({ good: t.good, buyAt: t.buyAt, sellAt: t.sellAt, promised: t.promised, made: t.made, at: t.at });
  }
  const starts: TripStart[] = [];
  for (const r of Array.isArray(o.starts) ? o.starts : []) {
    const s = r as Partial<TripStart>;
    if (!isStr(s.good) || !isStr(s.buyAt) || !isStr(s.shipSymbol) || !isNum(s.at) || s.at < since || s.at > now) continue;
    starts.push({ good: s.good, buyAt: s.buyAt, shipSymbol: s.shipSymbol, at: s.at, ...(isNum(s.price) && s.price > 0 ? { price: s.price } : {}) });
  }
  trips.sort((a, b) => a.at - b.at);
  starts.sort((a, b) => a.at - b.at);
  const sales: [string, RecentSale[]][] = [];
  for (const row of Array.isArray((o as { sales?: unknown }).sales) ? (o as { sales: unknown[] }).sales : []) {
    if (!Array.isArray(row) || !isStr(row[0]) || !Array.isArray(row[1])) continue;
    const list: RecentSale[] = [];
    for (const x of row[1] as unknown[]) {
      const r = x as Partial<RecentSale>;
      if (isNum(r.units) && r.units > 0 && isNum(r.at) && r.at >= since && r.at <= now) list.push({ units: r.units, at: r.at });
    }
    if (list.length) sales.push([row[0], list.sort((a, b) => a.at - b.at).slice(-TRIP_HISTORY_MAX)]);
  }
  const declined: [string, DeclinedLeg][] = [];
  for (const row of Array.isArray((o as { declined?: unknown }).declined) ? (o as { declined: unknown[] }).declined : []) {
    if (!Array.isArray(row) || !isStr(row[0])) continue;
    const d = row[1] as Partial<DeclinedLeg>;
    if (!d || !isStr(d.good) || !isNum(d.until) || d.until <= now) continue;
    declined.push([row[0], { good: d.good, ...(isStr(d.buyAt) ? { buyAt: d.buyAt } : {}), ...(isStr(d.sellAt) ? { sellAt: d.sellAt } : {}), wholeGood: d.wholeGood === true, until: d.until }]);
  }
  return { trips: trips.slice(-TRIP_HISTORY_MAX), starts: starts.slice(-TRIP_HISTORY_MAX), sales, declined };
}

/**
 * Saved rows plus the ones recorded since this process started, in time order. A saved row at or after the first live row
 * is the same event seen twice (saved after this process recorded it), so only saved rows older than the first live row
 * are kept. No key-based de-duplication: two ships can close the same route in the same millisecond.
 */
export function mergeTripHistory(saved: TripHistory, live: TripHistory): TripHistory {
  const before = <T extends { at: number }>(rows: readonly T[], liveRows: readonly T[]): T[] => {
    const firstLive = liveRows.length ? Math.min(...liveRows.map((r) => r.at)) : Infinity;
    return rows.filter((r) => r.at < firstLive);
  };
  return {
    trips: [...before(saved.trips, live.trips), ...live.trips].sort((a, b) => a.at - b.at).slice(-TRIP_HISTORY_MAX),
    starts: [...before(saved.starts, live.starts), ...live.starts].sort((a, b) => a.at - b.at).slice(-TRIP_HISTORY_MAX),
  };
}
