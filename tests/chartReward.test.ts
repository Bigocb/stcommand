import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chartGaps, chartRewardReport, creditDelta, type ChartEvent, type WalletRow } from "../src/engine/chartReward.js";

const row = (at: number, type: string, total: number, walletAfter: number): WalletRow => ({ at, type, total, walletAfter });
const chart = (at: number, ship = "S-1", detail = "charted X1-A-1: VIBRANT_AURORAS"): ChartEvent => ({ at, ship, detail });

describe("creditDelta", () => {
  it("signs the row types whose direction is known and refuses the rest", () => {
    assert.equal(creditDelta({ type: "SELL", total: 500 }), 500);
    assert.equal(creditDelta({ type: "CONTRACT", total: 900 }), 900);
    assert.equal(creditDelta({ type: "PURCHASE", total: 700 }), -700);
    assert.equal(creditDelta({ type: "REFUEL", total: 40 }), -40);
    assert.equal(creditDelta({ type: "JUMP", total: 6000 }), -6000);
    assert.equal(creditDelta({ type: "SHIP", total: 3_000_000 }), undefined, "purchases and scrap share a type");
  });
});

describe("chartRewardReport", () => {
  // Books that balance exactly, with two charts that each added credit nothing recorded.
  const rows = [
    row(1000, "SELL", 1000, 101_000),
    row(2000, "PURCHASE", 400, 100_600),        // balances: 101_000 - 400
    row(3000, "SELL", 600, 101_200),            // balances
    row(4000, "REFUEL", 50, 101_150),           // balances
    row(5000, "SELL", 100, 101_150 + 100 + 2_500), // a 2,500 reward landed before this row
    row(6000, "SELL", 100, 101_350 + 2_500),    // balances
    row(7000, "PURCHASE", 200, 101_350 + 2_500 - 200 + 7_000), // 7,000 reward landed before this row
  ];
  const charts = [chart(4500, "S-1", "charted X1-A-2: RARE_METAL_DEPOSITS"), chart(6500, "S-2", "charted X1-A-3: MEGA_STRUCTURES")];

  it("measures each single-chart gap's leftover as the reward", () => {
    const r = chartRewardReport(rows, charts);
    assert.equal(r.charts, 2);
    assert.equal(r.single.n, 2);
    assert.equal(r.single.positive, 2);
    assert.equal(r.single.min, 2_500);
    assert.equal(r.single.max, 7_000);
    assert.equal(r.single.median, 4_750);
    assert.equal(r.top[0]!.reward, 7_000);
    assert.equal(r.top[0]!.ship, "S-2");
    assert.match(r.top[0]!.detail, /MEGA_STRUCTURES/);
  });

  it("reports the self-check: gaps with no chart explain to zero", () => {
    const r = chartRewardReport(rows, charts);
    assert.equal(r.baseline.gaps, 4);
    assert.equal(r.baseline.exact, 4);
    assert.equal(r.baseline.exactShare, 1);
  });

  it("shows when the books are loose: a chart-free gap with a leftover lowers the share", () => {
    const loose = [...rows.slice(0, 2), row(2500, "SELL", 10, 100_600 + 10 + 333), ...rows.slice(2)];
    const r = chartRewardReport(loose, charts);
    assert.ok(r.baseline.exactShare! < 1);
  });

  it("spreads a leftover over several charts in one gap, and ignores gaps ending in an unknown row type", () => {
    const r = chartRewardReport(
      [row(1000, "SELL", 100, 10_000), row(2000, "SELL", 100, 10_100 + 600), row(3000, "SHIP", 5_000, 999_999)],
      [chart(1200), chart(1400), chart(1600), chart(2500)],
    );
    assert.equal(r.single.n, 0);
    assert.equal(r.multi.charts, 3);
    assert.equal(r.multi.perChart, 200);
  });

  it("can't bracket a chart before the first row", () => {
    const { gaps, assigned } = chartGaps([row(1000, "SELL", 1, 5), row(2000, "SELL", 1, 6)], [chart(500)]);
    assert.equal(gaps.length, 1);
    assert.equal(assigned, 0);
  });
});
