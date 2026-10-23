import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMetrics, bucketMinutesFor, projectToReset, rateNeeded, type LedgerRow } from "../src/engine/metrics.js";

const H = 3_600_000;
const NOW = 100 * H;
const row = (over: Partial<LedgerRow>): LedgerRow => ({ ts: NOW - 1000, ship: "T-1", waypoint: "X1-A-B1", type: "SELL", good: "FOOD", units: 10, total: 1000, pnl: 200, wallet: null, ...over });
const opts = { now: NOW, hours: 2, bucketMinutes: 60 };

describe("buildMetrics by waypoint", () => {
  it("ranks waypoints by realised profit and counts buys beside sales", () => {
    const m = buildMetrics([
      row({ waypoint: "X1-A-B1", pnl: 300, total: 1500 }),
      row({ waypoint: "X1-A-B2", pnl: 500, total: 2000 }),
      row({ waypoint: "X1-A-B2", type: "PURCHASE", total: 900, units: 10, pnl: null }),
      row({ waypoint: "X1-C-D1", type: "PURCHASE", total: 400, units: 4, pnl: null }),
    ], opts);
    assert.deepEqual(m.byWaypoint.map((w) => w.waypoint), ["X1-A-B2", "X1-A-B1", "X1-C-D1"]);
    const b2 = m.byWaypoint[0]!;
    assert.equal(b2.system, "X1-A");
    assert.equal(b2.profit, 500);
    assert.equal(b2.sells, 1);
    assert.equal(b2.buys, 1);
    assert.equal(b2.buySpend, 900);
  });
});

describe("buildMetrics", () => {
  it("buckets cargo purchases into units and average price paid, so a rising price shows as a line", () => {
    const m = buildMetrics([
      row({ type: "PURCHASE", ts: NOW - 2 * H + 1000, total: 1000, units: 10, pnl: null }),
      row({ type: "PURCHASE", ts: NOW - 2 * H + 2000, total: 1200, units: 10, pnl: null }),
      row({ type: "PURCHASE", ts: NOW - H + 1000, total: 900, units: 10, pnl: null }),
      row({ type: "SHIP", ts: NOW - H + 1500, total: 5000, pnl: null, good: "SHIP_LIGHT_HAULER" }),
    ], opts);
    assert.deepEqual(m.buckets.map((b) => b.unitsBought), [20, 10]);
    assert.deepEqual(m.buckets.map((b) => b.spend), [2200, 900]);
    assert.deepEqual(m.buckets.map((b) => b.avgBuy), [110, 90]);
  });


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

  it("counts repairs, booked or legacy negative, as overhead and net, but not ship purchases or scrap", () => {
    const m = buildMetrics([
      row({}),
      row({ type: "REFUEL", total: 50, pnl: null, good: null }),
      row({ type: "SHIP", total: 30, pnl: null, good: "REPAIR" }),
      row({ type: "SHIP", total: -20, pnl: null, good: null }),
      row({ type: "SHIP", total: 5000, pnl: null, good: "SHIP_LIGHT_HAULER" }),
      row({ type: "SHIP", total: 700, pnl: null, good: "SCRAP" }),
    ], opts);
    assert.equal(m.totals.repairs, 50);
    assert.equal(m.totals.net, 100); // 200 - 50 fuel - 50 repairs
    assert.equal(m.totals.overheadPct, 50);
    assert.equal(m.totals.shipsBought, 5000);
    assert.equal(m.totals.shipsBoughtCount, 1);
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

// A reset starts a different game. Rows from the previous universe must not reach this week's windows.
import { ledgerReadFrom } from "../src/engine/metrics.js";

describe("ledgerReadFrom", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-10-11T14:50:00Z");
  const nextReset = Date.parse("2026-10-18T13:00:00Z"); // the universe began a week earlier: 2026-10-11T13:00Z
  const universeStart = Date.parse("2026-10-11T13:00:00Z");

  it("reads twice the window when that stays inside the current universe", () => {
    assert.equal(ledgerReadFrom(now, 0.5, nextReset), now - H, "a 30 min window reads 1 h back, which is after 13:00");
  });

  it("stops at the universe's start instead of reading last week's rows", () => {
    assert.equal(ledgerReadFrom(now, 6, nextReset), universeStart, "6 h would reach back to 02:50, before the reset");
    assert.equal(ledgerReadFrom(now, 72, nextReset), universeStart);
  });

  it("clamps nothing while the next reset is unknown", () => {
    assert.equal(ledgerReadFrom(now, 6, undefined), now - 12 * H);
    assert.equal(ledgerReadFrom(now, 6, Number.NaN), now - 12 * H);
  });

  it("keeps the Credits figure from reading last week's closing wallet as a loss", () => {
    // The old universe ended with 900k in the wallet; this one has made 175k -> 600k.
    const row = (ts: string, wallet: number): LedgerRow => ({ ts: Date.parse(ts), ship: "S-1", waypoint: "X1-A-A1", type: "SELL", good: "G", units: 1, total: 10, pnl: 10, wallet });
    const rows = [row("2026-10-11T12:00:00Z", 900_000), row("2026-10-11T13:30:00Z", 175_000), row("2026-10-11T14:40:00Z", 600_000)];
    const opts = { now, hours: 1, bucketMinutes: 10 };
    const unbounded = buildMetrics(rows, { ...opts, hours: 6, bucketMinutes: 10 });
    assert.equal(unbounded.walletStart, 900_000, "without the bound the window starts from last week's wallet");
    const bounded = buildMetrics(rows.filter((r) => r.ts >= ledgerReadFrom(now, 6, nextReset)), { ...opts, hours: 6, bucketMinutes: 10 });
    assert.equal(bounded.walletStart, 175_000, "bounded, it starts from this universe's first wallet");
    assert.equal((bounded.walletEnd ?? 0) - (bounded.walletStart ?? 0), 425_000);
  });
});

describe("buildMetrics contracts", () => {
  const cRow = (over: Partial<LedgerRow>): LedgerRow => row({ ship: "fleet", waypoint: "", good: null, units: 0, pnl: null, ...over });
  const advance = (id: string, total: number): LedgerRow => cRow({ type: "CONTRACT", good: "ADVANCE", total, contractId: id });
  const payout = (id: string | null, total: number): LedgerRow => cRow({ type: "CONTRACT", good: "PAYOUT", total, contractId: id });
  const delivery = (id: string, units: number, pricePerUnit: number | null): LedgerRow => cRow({ type: "DELIVERY", good: "POLYNUCLEOTIDES", units, total: 0, pricePerUnit, contractId: id });

  it("nets income against the cost of the goods delivered, per contract", () => {
    const m = buildMetrics([advance("c1", 3107), delivery("c1", 22, 285), payout("c1", 7607)], opts);
    const t = m.contracts.totals;
    assert.deepEqual({ advances: t.advances, payouts: t.payouts, income: t.income, completed: t.completed, units: t.unitsDelivered, cost: t.costDelivered, net: t.net },
      { advances: 3107, payouts: 7607, income: 10714, completed: 1, units: 22, cost: 6270, net: 4444 });
    assert.deepEqual(m.contracts.byContract, [{ contractId: "c1", advance: 3107, payout: 7607, units: 22, cost: 6270, net: 4444, completed: true }]);
  });

  it("an old payout row (no id, no ADVANCE marker) still counts as a payout, under 'untracked'", () => {
    const m = buildMetrics([cRow({ type: "CONTRACT", good: null, total: 54_442 })], opts);
    assert.equal(m.contracts.totals.payouts, 54_442);
    assert.equal(m.contracts.byContract[0]!.contractId, "untracked");
  });

  it("mined cargo is costed at 0", () => {
    const m = buildMetrics([delivery("c1", 10, null), payout("c1", 5000)], opts);
    assert.equal(m.contracts.totals.costDelivered, 0);
    assert.equal(m.contracts.totals.net, 5000);
  });

  it("the headline net with contracts is trading net plus contract net, and trading net itself is unchanged", () => {
    const trading = [row({ pnl: 1000, total: 4000 })];
    const without = buildMetrics(trading, opts);
    const withContracts = buildMetrics([...trading, advance("c1", 100), delivery("c1", 10, 20), payout("c1", 900)], opts);
    assert.equal(withContracts.totals.net, without.totals.net, "Net trading must keep its meaning so weeks stay comparable");
    assert.equal(withContracts.contracts.totals.netInclContracts, without.totals.net + 100 + 900 - 200);
  });

  it("contract rows never leak into trading figures", () => {
    const m = buildMetrics([advance("c1", 100), delivery("c1", 10, 20), payout("c1", 900)], opts);
    assert.equal(m.totals.sells, 0);
    assert.equal(m.totals.revenue, 0);
    assert.equal(m.totals.spend, 0);
  });

  it("contract income is a share of all income and compares with the previous window", () => {
    const m = buildMetrics([
      row({ pnl: 100, total: 9000 }), payout("c1", 1000),
      { ...payout("c0", 400), ts: NOW - 3 * H }, // in the window before this one
    ], opts);
    assert.equal(m.contracts.totals.incomeSharePct, 10);
    assert.equal(m.contracts.previous.income, 400);
  });

  it("no contract rows means all zeros", () => {
    const m = buildMetrics([row({})], opts);
    assert.equal(m.contracts.totals.income, 0);
    assert.deepEqual(m.contracts.byContract, []);
  });
});
