import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deadheadFromTrades, type TradeRow } from "../src/engine/deadhead.js";

const H = 3_600_000;
const row = (ship: string, type: "PURCHASE" | "SELL", units: number, atMin: number, pnl: number | null = null): TradeRow => ({
  shipSymbol: ship, type, units, timestampMs: atMin * 60_000, total: units * 100, realizedPnl: pnl,
});

describe("deadheadFromTrades", () => {
  it("counts loaded time from first buy until the hold is sold down", () => {
    // 60-minute window; buys 2x20 at minutes 10 and 12, sells 40 at minute 40
    const r = deadheadFromTrades([row("A", "PURCHASE", 20, 10), row("A", "PURCHASE", 20, 12), row("A", "SELL", 40, 40, 9_000)], 0, H);
    const a = r.ships[0]!;
    assert.equal(a.loadedMs, 30 * 60_000);
    assert.equal(a.loadedShare, 0.5);
    assert.equal(a.trips, 1);
    assert.equal(a.pnl, 9_000);
    assert.equal(a.pnlPerLoadedHour, 18_000);
  });
  it("a window opening on a sell assumes the ship was already loaded", () => {
    const a = deadheadFromTrades([row("A", "SELL", 40, 15, 5_000)], 0, H).ships[0]!;
    assert.equal(a.loadedMs, 15 * 60_000);
  });
  it("a hold still carried at the end counts loaded to the window end", () => {
    const a = deadheadFromTrades([row("A", "PURCHASE", 40, 30)], 0, H).ships[0]!;
    assert.equal(a.loadedMs, 30 * 60_000);
    assert.equal(a.emptyMs, 30 * 60_000);
  });
  it("two trips and a fleet roll-up", () => {
    const rows = [row("A", "PURCHASE", 10, 0), row("A", "SELL", 10, 10, 1000), row("A", "PURCHASE", 10, 20), row("A", "SELL", 10, 40, 3000), row("B", "PURCHASE", 10, 0), row("B", "SELL", 10, 60, 6000)];
    const r = deadheadFromTrades(rows, 0, H);
    assert.equal(r.ships.find((s) => s.shipSymbol === "A")!.trips, 2);
    assert.equal(r.ships.find((s) => s.shipSymbol === "A")!.loadedMs, 30 * 60_000);
    assert.equal(r.fleet.pnl, 10_000);
    assert.equal(Math.round(r.fleet.loadedShare * 1000), Math.round(((30 + 60) / 120) * 1000));
  });
  it("ignores rows outside the window and handles none", () => {
    assert.deepEqual(deadheadFromTrades([], 0, H).ships, []);
    assert.equal(deadheadFromTrades([row("A", "SELL", 1, 90)], 0, H).ships.length, 0);
  });
});
