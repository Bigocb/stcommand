/**
 * Trips: every round trip rebuilt from the ledger, joined with what the bot expected when it chose the route.
 *
 * Pure. A trip is one ship and one good, from the first purchase until the hold of that good is sold down. Refuels and
 * jumps while a trip is open are its trip costs; those while the ship has no trip open are positioning costs, charged
 * to the trip that follows. A trip_planned action event within two minutes of the trip's first purchase (same ship,
 * same good) supplies the estimate.
 */
import type { ActionEventRow, AnalysisLedgerRow } from "../../db/store.js";
import { parseRouteTag } from "../routeTag.js";
import { confidenceFor, pct, round2, type AnalysisPolicy, type Finding } from "./types.js";

export interface Trip {
  shipSymbol: string;
  good: string;
  buyAt: string | null;
  sellAt: string | null;
  source: string | null;
  startMs: number;
  endMs: number | null;
  unitsBought: number;
  unitsSold: number;
  cost: number;
  revenue: number;
  /** Realized profit on the sales (ledger realized_pnl where present, else revenue - cost share). */
  realized: number;
  /** Refuels and jumps while the trip was open. */
  tripCosts: number;
  /** Refuels and jumps since the ship's previous trip closed. */
  positioningCosts: number;
  /** The window opened mid-trip: purchases before it are not seen. */
  partial: boolean;
  /** The estimate from trip_planned, when one matched. */
  expectedProfit: number | null;
  correlationId: string | null;
}

/** Profit of a trip after its own costs (the like-for-like comparison with the estimate). */
export const tripNet = (t: Trip): number => t.realized - t.tripCosts;
/** Profit of a trip after its own costs and the positioning that led to it. */
export const tripNetAll = (t: Trip): number => t.realized - t.tripCosts - t.positioningCosts;

const MATCH_WINDOW_MS = 2 * 60_000;

export function rebuildTrips(rows: readonly AnalysisLedgerRow[], events: readonly ActionEventRow[] = []): Trip[] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const open = new Map<string, Trip>(); // ship|good
  const pendingPositioning = new Map<string, number>(); // ship -> costs since its last trip closed
  const trips: Trip[] = [];
  const openFor = (ship: string) => [...open.values()].filter((t) => t.shipSymbol === ship);

  for (const r of sorted) {
    const at = Date.parse(r.timestamp);
    if (r.type === "REFUEL" || r.type === "JUMP") {
      const cost = Math.abs(r.total);
      const mine = openFor(r.shipSymbol);
      if (mine.length) for (const t of mine) t.tripCosts += cost / mine.length;
      else pendingPositioning.set(r.shipSymbol, (pendingPositioning.get(r.shipSymbol) ?? 0) + cost);
      continue;
    }
    if (!r.good) continue;
    const key = `${r.shipSymbol}|${r.good}`;
    const tag = parseRouteTag(r.route);
    let t = open.get(key);
    if (r.type === "PURCHASE") {
      if (!t) {
        t = {
          shipSymbol: r.shipSymbol, good: r.good, buyAt: tag?.buyAt ?? r.waypoint, sellAt: tag?.sellAt ?? null,
          source: tag?.source ?? null, startMs: at, endMs: null, unitsBought: 0, unitsSold: 0, cost: 0, revenue: 0,
          realized: 0, tripCosts: 0, positioningCosts: pendingPositioning.get(r.shipSymbol) ?? 0, partial: false,
          expectedProfit: null, correlationId: null,
        };
        pendingPositioning.delete(r.shipSymbol);
        open.set(key, t);
        trips.push(t);
      }
      t.unitsBought += r.units;
      t.cost += Math.abs(r.total);
    } else if (r.type === "SELL") {
      if (!t) {
        // The window opened mid-trip: the purchases are before it.
        t = {
          shipSymbol: r.shipSymbol, good: r.good, buyAt: tag?.buyAt ?? null, sellAt: tag?.sellAt ?? r.waypoint,
          source: tag?.source ?? null, startMs: at, endMs: null, unitsBought: 0, unitsSold: 0, cost: 0, revenue: 0,
          realized: 0, tripCosts: 0, positioningCosts: 0, partial: true, expectedProfit: null, correlationId: null,
        };
        open.set(key, t);
        trips.push(t);
      }
      t.sellAt = t.sellAt ?? tag?.sellAt ?? r.waypoint;
      t.unitsSold += r.units;
      t.revenue += r.total;
      if (r.realizedPnl !== null) t.realized += r.realizedPnl;
      else if (t.unitsBought > 0) t.realized += r.total - (t.cost / t.unitsBought) * r.units;
      if (t.partial || t.unitsSold >= t.unitsBought) {
        t.endMs = at;
        open.delete(key);
      }
    }
  }

  // Join the estimates.
  const planned = events.filter((e) => e.kind === "trip_planned");
  for (const t of trips) {
    if (t.partial) continue;
    const e = planned.find((p) => p.shipSymbol === t.shipSymbol && p.good === t.good && Math.abs(Date.parse(p.at) - t.startMs) <= MATCH_WINDOW_MS);
    if (!e) continue;
    const profit = Number((e.expected as { profit?: number } | undefined)?.profit);
    if (Number.isFinite(profit)) t.expectedProfit = profit;
    t.correlationId = e.correlationId ?? null;
  }
  return trips;
}

export interface RouteStats {
  key: string;
  good: string;
  route: string;
  trips: number;
  wins: number;
  netProfit: number;
  realized: number;
  tripCosts: number;
  positioningCosts: number;
  loadedHours: number;
  profitPerTrip: number;
  profitPerLoadedHour: number | null;
  /** Trips with an estimate, their expected and actual (like-for-like) totals, and the ratio. */
  estimated: number;
  expectedTotal: number;
  actualVsExpected: number | null;
  ships: string[];
}

export function summarizeRoutes(trips: readonly Trip[]): RouteStats[] {
  const by = new Map<string, Trip[]>();
  for (const t of trips) {
    if (t.endMs === null || t.partial) continue;
    const route = `${t.buyAt ?? "?"}>${t.sellAt ?? "?"}`;
    const key = `${t.good} ${route}`;
    (by.get(key) ?? by.set(key, []).get(key)!).push(t);
  }
  const out: RouteStats[] = [];
  for (const [key, list] of by) {
    const est = list.filter((t) => t.expectedProfit !== null);
    const expectedTotal = est.reduce((s, t) => s + (t.expectedProfit ?? 0), 0);
    const actualEst = est.reduce((s, t) => s + tripNet(t), 0);
    const loadedHours = list.reduce((s, t) => s + ((t.endMs ?? t.startMs) - t.startMs) / 3_600_000, 0);
    const netProfit = list.reduce((s, t) => s + tripNetAll(t), 0);
    out.push({
      key,
      good: list[0]!.good,
      route: key.slice(list[0]!.good.length + 1),
      trips: list.length,
      wins: list.filter((t) => tripNetAll(t) > 0).length,
      netProfit: Math.round(netProfit),
      realized: Math.round(list.reduce((s, t) => s + t.realized, 0)),
      tripCosts: Math.round(list.reduce((s, t) => s + t.tripCosts, 0)),
      positioningCosts: Math.round(list.reduce((s, t) => s + t.positioningCosts, 0)),
      loadedHours: round2(loadedHours),
      profitPerTrip: Math.round(netProfit / list.length),
      profitPerLoadedHour: loadedHours > 0.05 ? Math.round(netProfit / loadedHours) : null,
      estimated: est.length,
      expectedTotal: Math.round(expectedTotal),
      actualVsExpected: est.length && expectedTotal > 0 ? round2(actualEst / expectedTotal) : null,
      ships: [...new Set(list.map((t) => t.shipSymbol))].sort(),
    });
  }
  return out.sort((a, b) => b.netProfit - a.netProfit);
}

export function tripFindings(routes: readonly RouteStats[], policy: AnalysisPolicy): Finding[] {
  const out: Finding[] = [];
  for (const r of routes) {
    const base = { subject: r.key, sampleSize: r.trips, confidence: confidenceFor(r.trips) };
    if (r.trips >= policy.minTrips && r.netProfit > 0 && r.wins / r.trips >= 0.6) {
      out.push({
        ...base, id: `worked:${r.key}`, kind: "worked", weight: r.netProfit,
        headline: `${r.key} worked: ${r.netProfit}c over ${r.trips} trips (${r.profitPerTrip}c a trip, ${r.wins}/${r.trips} profitable)`,
        evidence: { netProfit: r.netProfit, trips: r.trips, profitPerTrip: r.profitPerTrip, profitPerLoadedHour: r.profitPerLoadedHour, wins: r.wins },
      });
    }
    if (r.trips >= policy.minTrips && r.netProfit < 0) {
      out.push({
        ...base, id: `didnt_work:${r.key}`, kind: "didnt_work", weight: -r.netProfit,
        headline: `${r.key} lost ${-r.netProfit}c over ${r.trips} trips (${r.wins}/${r.trips} profitable)`,
        evidence: { netProfit: r.netProfit, trips: r.trips, wins: r.wins, tripCosts: r.tripCosts, positioningCosts: r.positioningCosts },
        suggestion: {
          action: `Stop sending ships on ${r.key}, or find out why it loses (prices moved, costs, the estimate)`,
          why: `${r.trips - r.wins} of ${r.trips} trips lost money`,
        },
      });
    }
    if (r.estimated >= policy.minEstimateSamples && r.actualVsExpected !== null) {
      const optimistic = r.actualVsExpected < policy.estimateBiasRatio;
      const pessimistic = r.actualVsExpected > 1 / policy.estimateBiasRatio;
      if (optimistic || pessimistic) {
        out.push({
          id: `estimate:${r.key}`, kind: "estimate", subject: r.key, sampleSize: r.estimated, confidence: confidenceFor(r.estimated),
          weight: Math.abs(r.expectedTotal - Math.round(r.expectedTotal * r.actualVsExpected)),
          headline: `${r.key} earned ${pct(r.actualVsExpected)} of its estimate over ${r.estimated} trips (${optimistic ? "too optimistic" : "too cautious"})`,
          evidence: { actualVsExpected: r.actualVsExpected, expectedTotal: r.expectedTotal, trips: r.estimated },
          suggestion: optimistic
            ? { action: `Discount ${r.key} in planning (the calibration factor is ${r.actualVsExpected}); check impact and slippage on its markets`, why: "the route model keeps over-promising here" }
            : { action: `${r.key} is under-rated: the calibration factor is ${r.actualVsExpected}`, why: "the route model keeps under-promising here" },
        });
      }
    }
    const gross = r.realized - r.tripCosts;
    if (r.trips >= policy.minTrips && gross > 0 && r.positioningCosts / gross > policy.heavyPositioningShare) {
      out.push({
        ...base, id: `cost:positioning:${r.key}`, kind: "cost", weight: r.positioningCosts,
        headline: `${r.key}: positioning (jumps and fuel before the buy) ate ${pct(r.positioningCosts / gross)} of its profit`,
        evidence: { positioningCosts: r.positioningCosts, grossAfterTripCosts: Math.round(gross), trips: r.trips },
        suggestion: {
          action: "Lower the positioning jump limit so ships take routes closer to where they are",
          why: `${r.positioningCosts}c of positioning on ${r.trips} trips`,
          tool: "stcommand_set_doctrine", args: { key: "positioningHops", value: 3 },
        },
      });
    }
  }
  return out;
}
