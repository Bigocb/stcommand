import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tradeTempo } from "../src/engine/tradeTempo.js";
import type { LedgerRow } from "../src/engine/metrics.js";

const T0 = Date.UTC(2026, 9, 31, 20, 0, 0);
const row = (sec: number, ship: string, type: string, good: string | null, waypoint: string, total = 1000, pnl: number | null = null): LedgerRow => ({ ts: T0 + sec * 1000, ship, waypoint, type, good, units: 10, total, pnl, wallet: null });

describe("tradeTempo", () => {
  it("counts bursts once and splits ships into trading, travelling and silent", () => {
    const rows = [
      row(1, "A", "PURCHASE", "IRON", "X-1"),
      row(3, "A", "PURCHASE", "IRON", "X-1"),
      row(5, "A", "PURCHASE", "IRON", "X-1"),
      row(60, "A", "SELL", "IRON", "X-2", 3000, 500),
      row(70, "B", "JUMP", null, "X-9"),
      row(80, "C", "SELL", "COPPER", "X-3", 2000, 100),
      row(400, "A", "SELL", "IRON", "X-2", 1000, 50),
    ];
    // B has traded elsewhere in the window so it is a known trader.
    rows.push(row(-10_000, "B", "SELL", "GOLD", "X-4"));
    const t = tradeTempo(rows, { sinceMs: T0 - 20_000_000, nowMs: T0 + 3_600_000, bucketMin: 5 });
    assert.equal(t.knownTraders, 3);
    const first = t.buckets.find((b) => b.from === new Date(T0).toISOString())!;
    assert.equal(first.tripsStarted, 1);
    assert.equal(first.tripsEnded, 2);
    assert.equal(first.tradingShips, 2);
    assert.equal(first.travellingShips, 1);
    assert.equal(first.silentShips, 0);
    assert.equal(first.matchedProfit, 600);
    assert.equal(first.purchaseValue, 3000);
    const second = t.buckets.find((b) => b.from === new Date(T0 + 300_000).toISOString())!;
    assert.equal(second.tradingShips, 1);
    assert.equal(second.silentShips, 2);
  });

  it("separates bursts more than 15 s apart", () => {
    const rows = [row(0, "A", "SELL", "IRON", "X-1"), row(30, "A", "SELL", "IRON", "X-1")];
    const t = tradeTempo(rows, { sinceMs: T0, nowMs: T0 + 600_000 });
    assert.equal(t.buckets[0]!.tripsEnded, 2);
  });

  it("ignores ships that never traded and is empty-safe", () => {
    const t = tradeTempo([row(1, "K", "REFUEL", null, "X-1")], { sinceMs: T0, nowMs: T0 + 600_000 });
    assert.equal(t.knownTraders, 0);
    assert.equal(t.buckets.length, 0);
  });
});
