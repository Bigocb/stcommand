import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMetrics, bucketMinutesFor, projectToReset, rateNeeded, type LedgerRow } from "../src/engine/metrics.js";

const H = 3_600_000;
const NOW = 100 * H;
const row = (over: Partial<LedgerRow>): LedgerRow => ({ ts: NOW - 1000, ship: "T-1", waypoint: "X1-A-B1", type: "SELL", good: "FOOD", units: 10, total: 1000, pnl: 200, wallet: null, ...over });
const opts = { now: NOW, hours: 2, bucketMinutes: 60 };

describe("buildMetrics", () => {
  it("counts realized profit less fuel and jumps as net trading, and keeps ships and scrap out of it", () => {
    const m = buildMetrics([
      row({}),
      row({ pnl: 300, total: 1500 }),
      row({ type: "REFUEL", total: 50, pnl: null, good: null }),
      row({ type: "JUMP", total: 100, pnl: null, good: null }),
      row({ type: "SHIP", total: 5000, pnl: null, good: "SHIP_LIGHT_HAULER" }),
      row({ type: "SHIP", total: 700, pnl: null, good: "SCRAP" }),
      row({ type: "PURCHASE", total: 900, pnl: null }),
    ], opts);
    assert.equal(m.totals.profit, 500);
    assert.equal(m.totals.net, 350);
    assert.equal(m.totals.shipsBought, 5000);
    assert.equal(m.totals.shipsBoughtCount, 1);
    assert.equal(m.totals.scrapProceeds, 700);
    assert.equal(m.totals.spend, 900);
    assert.equal(m.totals.sells, 2);
    assert.equal(m.totals.netPerHour, 175);
  });

  it("leaves a sale with no cost basis out of profit and reports it separately", () => {
    const m = buildMetrics([row({}), row({ pnl: null, total: 400 })], opts);
    assert.equal(m.totals.profit, 200);
    assert.equal(m.totals.unmatchedRevenue, 400);
    assert.equal(m.totals.revenue, 1400);
  });

  it("buckets oldest first with a running total, and ignores rows outside the window", () => {
    const m = buildMetrics([
      row({ ts: NOW - 90 * 60_000, pnl: 100 }), // first bucket
      row({ ts: NOW - 10 * 60_000, pnl: 300 }), // last bucket
      row({ ts: NOW - 5 * H, pnl: 9999 }),       // before the window (and before the previous one)
    ], opts);
    assert.equal(m.buckets.length, 2);
    assert.deepEqual(m.buckets.map((b) => b.net), [100, 300]);
    assert.deepEqual(m.buckets.map((b) => b.cumNet), [100, 400]);
    assert.equal(m.totals.net, 400);
  });

  it("compares with the window just before it", () => {
    const m = buildMetrics([row({ pnl: 300 }), row({ ts: NOW - 3 * H, pnl: 100 })], opts);
    assert.equal(m.totals.profit, 300);
    assert.equal(m.previous.profit, 100);
  });

  it("carries the wallet forward through empty buckets and starts from the last one before the window", () => {
    const m = buildMetrics([
      row({ ts: NOW - 3 * H, wallet: 5000, pnl: 0 }),
      row({ ts: NOW - 30 * 60_000, wallet: 7000 }),
    ], opts);
    assert.equal(m.walletStart, 5000);
    assert.deepEqual(m.buckets.map((b) => b.wallet), [5000, 7000]);
    assert.equal(m.walletEnd, 7000);
  });

  it("breaks profit down by good, ship and sell system, best first", () => {
    const m = buildMetrics([
      row({ good: "FOOD", pnl: 100, ship: "T-1", waypoint: "X1-A-B1" }),
      row({ good: "RELIC_TECH", pnl: 900, units: 36, ship: "T-2", waypoint: "X1-B-C1", total: 2000 }),
      row({ good: "FOOD", pnl: 100, ship: "T-1", waypoint: "X1-A-B2" }),
    ], { ...opts, holds: { "T-1": 40, "T-2": 150 }, traders: ["T-1", "T-2", "T-3"] });
    assert.deepEqual(m.byGood.map((g) => g.good), ["RELIC_TECH", "FOOD"]);
    assert.equal(m.byGood[0]!.profitPerUnit, 25);
    assert.deepEqual(m.byShip.map((s) => [s.ship, s.hold, s.profit]), [["T-2", 150, 900], ["T-1", 40, 200]]);
    assert.deepEqual(m.bySystem.map((s) => [s.system, s.profit]), [["X1-B", 900], ["X1-A", 200]]);
    assert.deepEqual(m.idleTraders, ["T-3"]);
  });

  it("reports margin and overhead as shares", () => {
    const m = buildMetrics([row({ pnl: 200, total: 1000 }), row({ type: "REFUEL", total: 40, pnl: null, good: null })], opts);
    assert.equal(m.totals.marginPct, 25); // 200 on a 800 cost basis
    assert.equal(m.totals.overheadPct, 20); // 40 of 200
  });

  it("is empty and safe with no rows", () => {
    const m = buildMetrics([], opts);
    assert.equal(m.totals.net, 0);
    assert.equal(m.buckets.length, 2);
    assert.equal(m.walletEnd, null);
    assert.deepEqual(m.byGood, []);
  });
});

describe("range helpers", () => {
  it("keeps a chart to a readable number of points", () => {
    for (const h of [1, 6, 24, 72, 144]) {
      const points = (h * 60) / bucketMinutesFor(h);
      assert.ok(points >= 30 && points <= 100, `${h}h gives ${points} points`);
    }
  });
  it("projects a straight line to reset and says what rate a target needs", () => {
    assert.equal(projectToReset(10_000_000, 400_000, 10), 14_000_000);
    assert.equal(projectToReset(10_000_000, 400_000, -3), 10_000_000);
    assert.equal(rateNeeded(10_000_000, 25_000_000, 30), 500_000);
    assert.equal(rateNeeded(30_000_000, 25_000_000, 30), 0);
    assert.equal(rateNeeded(1, 2, 0), 0);
  });
});

import { worthByBucket } from "../src/engine/metrics.js";

describe("worthByBucket", () => {
  it("takes the latest sample in each bucket and carries the last value forward over empty buckets", () => {
    const starts = [0, H, 2 * H, 3 * H];
    const series = worthByBucket(starts, 60, [
      { ts: 10 * 60_000, worth: 100 },
      { ts: 50 * 60_000, worth: 120 },
      { ts: 2 * H + 5 * 60_000, worth: 200 },
    ]);
    assert.deepEqual(series, [120, 120, 200, 200]);
  });

  it("is null until the first sample", () => {
    assert.deepEqual(worthByBucket([0, H], 60, []), [null, null]);
  });
});
