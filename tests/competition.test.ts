import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActionEventRow, AnalysisLedgerRow } from "../src/db/store.js";
import { rebuildTrips } from "../src/engine/analysis/trips.js";
import type { MarketTrade } from "../src/engine/analysis/priceMoves.js";
import { bucketFor, competitionFindings, summarizeCompetition, tripExposures } from "../src/engine/analysis/competition.js";
import { buildAnalysisReport } from "../src/engine/analysis/report.js";
import { DEFAULT_ANALYSIS_POLICY as P } from "../src/engine/analysis/types.js";

const T0 = Date.parse("2026-10-15T00:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const row = (min: number, ship: string, type: string, good: string, waypoint: string, units: number, price: number, extra: Partial<AnalysisLedgerRow> = {}): AnalysisLedgerRow => ({
  timestamp: at(min), shipSymbol: ship, type, good, waypoint, units, pricePerUnit: price, total: units * price, realizedPnl: null, route: null, ...extra,
});
const planned = (min: number, ship: string, good: string, profit: number): ActionEventRow => ({
  at: at(min), universeKey: null, kind: "trip_planned", actor: "engine", shipSymbol: ship, good, correlationId: `trip:${ship}:${good}:${min}`, expected: { profit },
});
const trade = (min: number, waypoint: string, ship: string, units: number, good = "FOOD"): MarketTrade => ({ timestamp: at(min), waypoint, good, shipSymbol: ship, type: "SELL", units });

/** A trip from X1-A-1 to X1-A-2 starting at `start`; profit 2000 on an estimate of 2000 unless `sellPrice` says otherwise. */
function trip(ship: string, start: number, sellPrice = 150): { rows: AnalysisLedgerRow[]; events: ActionEventRow[] } {
  const route = "X1-A-1>X1-A-2 auto";
  return {
    rows: [
      row(start, ship, "PURCHASE", "FOOD", "X1-A-1", 40, 100, { route }),
      row(start + 10, ship, "SELL", "FOOD", "X1-A-2", 40, sellPrice, { route, realizedPnl: 40 * (sellPrice - 100) }),
    ],
    events: [planned(start + 1, ship, "FOOD", 2000)],
  };
}

const ours = new Set(["S-1", "S-2", "S-3"]);

describe("competition", () => {
  it("buckets by rival units across both markets", () => {
    assert.equal(bucketFor(0, P), "none");
    assert.equal(bucketFor(1, P), "light");
    assert.equal(bucketFor(P.heavyRivalUnits, P), "heavy");
  });

  it("counts rival units before the buy and before the sell, and our own ships apart from rivals", () => {
    const { rows, events } = trip("S-1", 120);
    const trades = [
      trade(100, "X1-A-1", "RIVAL-1", 60), // 20 min before the buy: counts
      trade(10, "X1-A-1", "RIVAL-2", 500), // hours before: outside the window
      trade(125, "X1-A-2", "RIVAL-1", 30), // 5 min before the sell: counts
      trade(110, "X1-A-1", "S-2", 40), // our other ship
      trade(105, "X1-A-1", "S-1", 40), // the trip's own ship is never counted
      trade(110, "X1-A-1", "RIVAL-1", 9, "IRON"), // another good
    ];
    const [e] = tripExposures(rebuildTrips(rows, events), trades, ours, P);
    assert.equal(e!.rivalBuy, 60);
    assert.equal(e!.rivalSell, 30);
    assert.equal(e!.ownBuy, 40);
    assert.equal(e!.ownSell, 0);
    // 90 rival units across both markets is below the heavy line
    assert.equal(e!.bucket, "light");
  });

  it("skips trips without an estimate and trips still open", () => {
    const a = trip("S-1", 10);
    const noEstimate = tripExposures(rebuildTrips(a.rows, []), [], ours, P);
    assert.equal(noEstimate.length, 0);
    const open = tripExposures(rebuildTrips([a.rows[0]!], a.events), [], ours, P);
    assert.equal(open.length, 0);
  });

  it("compares realized over estimated by bucket", () => {
    const rows: AnalysisLedgerRow[] = [];
    const events: ActionEventRow[] = [];
    const trades: MarketTrade[] = [];
    for (let i = 0; i < 4; i++) {
      const q = trip("S-1", 10 + i * 60); // quiet: earns the full 2000
      rows.push(...q.rows); events.push(...q.events);
      const h = trip("S-2", 10 + i * 60, 125); // heavy: earns 1000 on the same estimate
      rows.push(...h.rows); events.push(...h.events);
      trades.push(trade(5 + i * 60, "X1-A-1", "RIVAL-1", 200)); // before S-2's buys, and S-1's: see below
    }
    // Rival trades reach both ships' buys at the same minute; give S-1 a market where nobody trades instead.
    const quietRows = rows.filter((r) => r.shipSymbol === "S-1").map((r) => ({ ...r, waypoint: r.waypoint === "X1-A-1" ? "X1-B-1" : "X1-B-2", route: "X1-B-1>X1-B-2 auto" }));
    const heavyRows = rows.filter((r) => r.shipSymbol === "S-2");
    const stats = summarizeCompetition(tripExposures(rebuildTrips([...quietRows, ...heavyRows], events), trades, ours, P));
    const quiet = stats.buckets.find((b) => b.bucket === "none")!;
    const heavy = stats.buckets.find((b) => b.bucket === "heavy")!;
    assert.equal(quiet.trips, 4);
    assert.equal(quiet.ratio, 1);
    assert.equal(heavy.trips, 4);
    assert.equal(heavy.ratio, 0.5);
    assert.equal(heavy.medianTripRatio, 0.5);
    assert.equal(stats.systems[0]!.system, "X1-A");
  });

  it("reports a finding only with enough trips on both sides and a gap that matters", () => {
    const bucket = (b: "none" | "heavy", trips: number, ratio: number) => ({ bucket: b, trips, expected: 10000, actual: 10000 * ratio, ratio, medianTripRatio: ratio });
    const stats = (quiet: ReturnType<typeof bucket>, heavy: ReturnType<typeof bucket>) => ({ buckets: [quiet, { bucket: "light" as const, trips: 0, expected: 0, actual: 0, ratio: null, medianTripRatio: null }, heavy], ownUnitsPerTrip: { none: 0, light: 0, heavy: 0 }, systems: [] });
    const found = competitionFindings(stats(bucket("none", 10, 1.1), bucket("heavy", 10, 0.8)), P);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.kind, "competition");
    assert.equal(found[0]!.sampleSize, 10);
    assert.deepEqual(competitionFindings(stats(bucket("none", 10, 1.1), bucket("heavy", 3, 0.8)), P), []);
    assert.deepEqual(competitionFindings(stats(bucket("none", 10, 1.05), bucket("heavy", 10, 1.0)), P), []);
    assert.deepEqual(competitionFindings(stats(bucket("none", 10, 0.9), bucket("heavy", 10, 1.1)), P), []);
  });

  it("is part of the report", () => {
    const { rows, events } = trip("S-1", 10);
    const report = buildAnalysisReport({ fromMs: T0, nowMs: T0 + 3_600_000, ledger: rows, events, snapshots: [], marketTrades: [trade(5, "X1-A-1", "RIVAL-1", 500)], ourShips: ours });
    assert.equal(report.competition.buckets.find((b) => b.bucket === "heavy")!.trips, 1);
  });
});
