import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profitCurve, type CurveBucket } from "../src/engine/profitCurve.js";

const b = (iso: string, o: Partial<CurveBucket> = {}): CurveBucket => ({ bucket: new Date(iso), sells: 10, units: 500, pnl: 100_000, revenue: 900_000, sellers: 5, purchases: 800_000, overhead: 1_000, shipsBought: 0, wallet: 1_000_000, ...o });

describe("profitCurve", () => {
  it("derives per-sell and per-unit profit and a running total", () => {
    const { rows } = profitCurve([b("2026-11-05T10:00:00Z"), b("2026-11-05T11:00:00Z", { pnl: 300_000, sells: 20, units: 1000 })], 60);
    assert.equal(rows[0]!.profitPerSell, 10_000);
    assert.equal(rows[0]!.profitPerUnit, 200);
    assert.equal(rows[1]!.profitPerSell, 15_000);
    assert.equal(rows[1]!.cumulativeProfit, 400_000);
  });
  it("totals each day with its weekday and an hourly rate", () => {
    const { days } = profitCurve([b("2026-11-05T10:00:00Z"), b("2026-11-05T11:00:00Z"), b("2026-11-06T10:00:00Z", { pnl: 900_000 })], 60);
    assert.equal(days[0]!.weekday, "Thu");
    assert.equal(days[0]!.profit, 200_000);
    assert.equal(days[0]!.profitPerHour, 100_000);
    assert.equal(days[1]!.weekday, "Fri");
    assert.equal(days[1]!.profit, 900_000);
  });
  it("names the peak bucket as an hourly rate whatever the bucket size", () => {
    const { peak } = profitCurve([b("2026-11-05T10:00:00Z", { pnl: 50_000 }), b("2026-11-05T10:30:00Z", { pnl: 200_000 })], 30);
    assert.equal(peak!.profitPerHour, 400_000);
  });
  it("handles an empty window", () => {
    const r = profitCurve([], 60);
    assert.deepEqual(r.rows, []);
    assert.equal(r.peak, null);
    assert.equal(r.reading, "no sells in the window");
  });
  it("does not divide by zero on a bucket with no sells", () => {
    const { rows } = profitCurve([b("2026-11-05T10:00:00Z", { sells: 0, units: 0, pnl: 0 })], 60);
    assert.equal(rows[0]!.profitPerSell, 0);
    assert.equal(rows[0]!.profitPerUnit, 0);
  });
});
