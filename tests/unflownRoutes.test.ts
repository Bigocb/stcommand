import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hullCargo, unflownRoutes } from "../src/engine/unflownRoutes.js";

const adj = new Map<string, string[]>([["A", ["B"]], ["B", ["A", "C"]], ["C", ["B"]]]);
const route = (good: string, buyAt: string, p: number) => ({ good, buyAt, buySystem: buyAt.split("-")[0]!, sellAt: `${buyAt}-S`, sellSystem: buyAt.split("-")[0]!, buyPrice: 1, sellPrice: 2, profitPerTrip: p, profitByHold: { "225": p / 2, "490": p } });

describe("unflownRoutes", () => {
  it("skips flown routes, finds the nearest trader and the nearest big-hull yards", () => {
    const rows = unflownRoutes({
      routes: [route("FOOD", "A-1", 200_000), route("EQUIP", "C-1", 300_000), route("TINY", "A-2", -5)],
      assignments: [{ shipSymbol: "T-1", good: "EQUIP", buyAt: "C-1", sellAt: "C-1-S" }],
      traders: [{ ship: "T-1", system: "C", hold: 225, busy: true }, { ship: "T-2", system: "B", hold: 80, busy: false }],
      yards: [
        { waypoint: "B-Y", system: "B", shipType: "SHIP_HEAVY_FREIGHTER", cargo: 225, price: 2_100_000, at: "t" },
        { waypoint: "A-Y", system: "A", shipType: "SHIP_LIGHT_HAULER", cargo: 80, price: 300_000, at: "t" },
        { waypoint: "C-Y", system: "C", shipType: "SHIP_BULK_FREIGHTER", cargo: 490, price: 4_500_000, at: "t" },
      ],
      adj,
    });
    assert.deepEqual(rows.map((r) => r.good), ["FOOD"], "flown and unprofitable routes are left out");
    const r = rows[0]!;
    assert.deepEqual(r.nearestFreeTrader, { ship: "T-2", hops: 1, hold: 80 });
    assert.equal(r.at225, 100_000);
    assert.deepEqual(r.yards.map((y) => [y.yard, y.hops]), [["B-Y", 1], ["C-Y", 2]], "light hauler is not big; nearest first");
  });

  it("one row per buy market and good, and the limit holds", () => {
    const rows = unflownRoutes({ routes: [route("FOOD", "A-1", 9), { ...route("FOOD", "A-1", 8), sellAt: "A-9" }, route("X", "B-1", 7)], assignments: [], traders: [], yards: [], adj, limit: 1 });
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.verdict, /no free trader/);
  });

  it("reads a hull's cargo from its modules", () => {
    assert.equal(hullCargo([{ symbol: "MODULE_CARGO_HOLD_III", capacity: 75 }, { symbol: "MODULE_CREW_QUARTERS_I", capacity: 40 }, { symbol: "MODULE_CARGO_HOLD_III", capacity: 75 }], 0), 150);
  });
});
