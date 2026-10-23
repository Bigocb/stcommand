import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CRASH_POLICY, estimateSellPrice, profitAfterShortfall, type SaleImpact } from "../src/engine/marketCrash.js";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const on = { recoveryMin: 90 };
// THEOREM-152 at X1-YB39-BD3D, 2026-10-23: first lot 5836, last lot 4609.
const dump = (at: number): SaleImpact[] => [
  { units: 20, at, price: 5836 },
  { units: 60, at: at + 2_000, price: 5643 },
  { units: 60, at: at + 5_000, price: 5232 },
  { units: 40, at: at + 9_000, price: 4609 },
];

describe("marketCrash", () => {
  it("is off at 0 minutes and with no sales, whatever the data says", () => {
    const sales = dump(NOW - 10 * MIN);
    assert.deepEqual(estimateSellPrice(sales, 5836, NOW - 20 * MIN, NOW, DEFAULT_CRASH_POLICY), { price: 5836, shortfall: 0 });
    assert.deepEqual(estimateSellPrice([], 5836, NOW - 20 * MIN, NOW, on), { price: 5836, shortfall: 0 });
  });

  it("plans below the listed price right after a dump, and recovers along a line", () => {
    const sales = dump(NOW - 9_000); // just sold
    const fresh = estimateSellPrice(sales, 5836, NOW - 5 * MIN, NOW, on);
    assert.equal(fresh.price, 4609); // the last lot sold at this very moment: nothing has refilled yet
    assert.ok(fresh.shortfall > 1200);
    assert.match(fresh.reason!, /sold 5836c -> 4609c/);
    const half = estimateSellPrice(dump(NOW - 45 * MIN), 5836, NOW - 60 * MIN, NOW, on);
    assert.ok(half.price > 5100 && half.price < 5300, `half way back, got ${half.price}`);
    // 59 minutes later (the 152 case) it is still short, where the old 30-minute discount had already gone
    const hourLater = estimateSellPrice(dump(NOW - 59 * MIN), 5836, NOW - 60 * MIN, NOW, on);
    assert.ok(hourLater.shortfall > 300);
  });

  it("is fully refilled after the recovery time, and ignores sales older than it", () => {
    assert.equal(estimateSellPrice(dump(NOW - 120 * MIN), 5836, NOW - 130 * MIN, NOW, on).shortfall, 0);
  });

  it("does not charge a dump the snapshot already shows", () => {
    // snapshot taken after the sales: the listed price is already the low one
    assert.equal(estimateSellPrice(dump(NOW - 30 * MIN), 4609, NOW - 10 * MIN, NOW, on).shortfall, 0);
  });

  it("ignores a run whose price did not fall", () => {
    const flat: SaleImpact[] = [{ units: 20, at: NOW - 5 * MIN, price: 3000 }, { units: 20, at: NOW - 4 * MIN, price: 3010 }];
    assert.equal(estimateSellPrice(flat, 3000, NOW - 10 * MIN, NOW, on).shortfall, 0);
  });

  it("never plans above the listed price", () => {
    // the listed price is already below where the first sale was
    assert.equal(estimateSellPrice(dump(NOW - 60 * MIN), 4000, NOW - 70 * MIN, NOW, on).price, 4000);
  });

  it("turns the per-unit shortfall into a trip's profit, which can go negative", () => {
    assert.equal(profitAfterShortfall(371_290, 600, 180), 371_290 - 108_000);
    assert.ok(profitAfterShortfall(100_000, 1_200, 180) < 0);
  });
});
