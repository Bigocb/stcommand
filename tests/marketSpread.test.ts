import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { marketSpread } from "../src/engine/marketSpread.js";
import type { LedgerRow } from "../src/engine/metrics.js";

const T0 = Date.UTC(2026, 9, 31, 20, 0, 0);
const row = (min: number, ship: string, type: string, good: string, waypoint: string, total = 1000): LedgerRow => ({ ts: T0 + min * 60_000, ship, waypoint, type, good, units: 10, total, pnl: null, wallet: null });

describe("marketSpread", () => {
  it("counts distinct markets, pairs and goods per bucket", () => {
    const rows = [
      row(1, "A", "PURCHASE", "IRON", "X-1"),
      row(2, "B", "PURCHASE", "IRON", "X-1"),
      row(3, "A", "SELL", "IRON", "X-2", 3000),
      row(4, "B", "SELL", "COPPER", "X-3", 1000),
      row(20, "A", "SELL", "IRON", "X-2", 500),
    ];
    const r = marketSpread(rows, [], { nowMs: T0 + 30 * 60_000, sinceMs: T0, bucketMin: 15 });
    assert.equal(r.buckets.length, 2);
    const b = r.buckets[0]!;
    assert.equal(b.ships, 2);
    assert.equal(b.buyMarkets, 1);
    assert.equal(b.sellMarkets, 2);
    assert.equal(b.markets, 3);
    assert.equal(b.goodMarketPairs, 3);
    assert.equal(b.goods, 2);
    assert.equal(b.sells, 2);
    assert.equal(b.sellValue, 4000);
    assert.equal(b.top5SellShare, 1);
  });

  it("measures crowding as the top-five share of sales", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(1, "A", "SELL", "IRON", `X-${i}`, 100));
    const r = marketSpread(rows, [], { nowMs: T0 + 10 * 60_000, sinceMs: T0 });
    assert.equal(r.buckets[0]!.top5SellShare, 0.5);
  });

  it("ignores rows outside the window and non-trade rows", () => {
    const rows = [row(-5, "A", "SELL", "IRON", "X-1"), row(1, "A", "REFUEL", "FUEL", "X-1"), row(2, "A", "SELL", "IRON", "X-1")];
    const r = marketSpread(rows, [], { nowMs: T0 + 10 * 60_000, sinceMs: T0 });
    assert.equal(r.buckets.length, 1);
    assert.equal(r.buckets[0]!.sells, 1);
  });

  it("summarizes trips in flight and the busiest market", () => {
    const legs = [
      { shipSymbol: "A", good: "IRON", buyAt: "X-1", sellAt: "X-9", units: 40 },
      { shipSymbol: "B", good: "COPPER", buyAt: "X-2", sellAt: "X-9", units: 40 },
    ];
    const r = marketSpread([], legs, { nowMs: T0, sinceMs: T0 - 3_600_000 });
    assert.equal(r.now.ships, 2);
    assert.equal(r.now.markets, 3);
    assert.equal(r.now.goodMarketPairs, 4);
    assert.deepEqual(r.now.busiestMarket, { waypoint: "X-9", ships: 2 });
    assert.equal(r.now.shipsPerMarket, 0.67);
  });

  it("is empty-safe", () => {
    const r = marketSpread([], [], { nowMs: T0, sinceMs: T0 - 1000 });
    assert.equal(r.buckets.length, 0);
    assert.equal(r.now.shipsPerMarket, 0);
  });
});
