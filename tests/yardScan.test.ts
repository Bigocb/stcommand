import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holdOf, scoreOf, yardReport, type YardRow } from "../src/engine/yardScan.js";

const now = Date.parse("2026-10-29T12:00:00Z");
const row = (o: Partial<YardRow>): YardRow => ({ systemSymbol: "X1-A", waypointSymbol: "X1-A-1", shipType: "SHIP_X", purchasePrice: 100_000, engineSpeed: 15, cargoCapacity: 0, modules: [{ symbol: "MODULE_CARGO_HOLD_II" }], timestamp: "2026-10-29T10:00:00Z", ...o });

describe("yardScan", () => {
  it("reads the hold from cargo modules when the yard's own figure is 0", () => {
    assert.equal(holdOf(row({})), 40);
    assert.equal(holdOf(row({ modules: [{ symbol: "MODULE_CARGO_HOLD_III" }, { symbol: "MODULE_CARGO_HOLD_III" }, { symbol: "MODULE_JUMP_DRIVE_I" }] })), 150);
    assert.equal(holdOf(row({ cargoCapacity: 80, modules: [] })), 80);
    assert.equal(holdOf(row({ modules: [{ symbol: "MODULE_CARGO_HOLD_II", capacity: 45 }] })), 45);
  });
  it("scores cargo x speed per 1,000 credits", () => {
    assert.equal(scoreOf(40, 15, 100_000), 6);
    assert.equal(scoreOf(40, 15, 0), 0);
  });
  it("keeps the cheapest yard per hull type and ranks by score", () => {
    const r = yardReport([
      row({ shipType: "SHIP_SHUTTLE", purchasePrice: 90_000, waypointSymbol: "X1-A-1" }),
      row({ shipType: "SHIP_SHUTTLE", purchasePrice: 80_000, waypointSymbol: "X1-B-1", systemSymbol: "X1-B" }),
      row({ shipType: "SHIP_BULK", waypointSymbol: "X1-C-1", purchasePrice: 4_000_000, engineSpeed: 60, modules: [{ symbol: "MODULE_CARGO_HOLD_III" }, { symbol: "MODULE_CARGO_HOLD_III" }] }),
    ], now);
    assert.equal(r.yardsRead, 3);
    const shuttle = r.ranked.find((o) => o.shipType === "SHIP_SHUTTLE")!;
    assert.equal(shuttle.price, 80_000);
    assert.equal(shuttle.yardsOffering, 2);
    assert.equal(shuttle.ageHours, 2);
    assert.equal(r.ranked[0]!.shipType, "SHIP_SHUTTLE"); // 7.5 per k beats the freighter's 2.25
  });
  it("lists fast and affordable hulls, and says so when there are none", () => {
    const none = yardReport([row({}), row({ shipType: "SHIP_BULK", purchasePrice: 4_000_000, engineSpeed: 60 })], now);
    assert.equal(none.fastAndAffordable.length, 0);
    assert.match(none.note, /No hull faster than 15/);
    const some = yardReport([row({ shipType: "SHIP_FAST", purchasePrice: 700_000, engineSpeed: 36 })], now);
    assert.deepEqual(some.fastAndAffordable.map((o) => o.shipType), ["SHIP_FAST"]);
  });
  it("skips rows with no price or speed", () => {
    assert.equal(yardReport([row({ engineSpeed: null }), row({ purchasePrice: 0 })], now).hulls, 0);
  });
});
