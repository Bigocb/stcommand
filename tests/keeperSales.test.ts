import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keeperSales, type StationedKeeper, type WaypointTrade } from "../src/engine/keeperSales.js";

const trade = (waypoint: string, sells: number, buys: number): WaypointTrade =>
  ({ waypoint, sells, sellUnits: sells * 20, sellValue: sells * 1000, buys, buyUnits: buys * 20, buyValue: buys * 800 });
const keepers: StationedKeeper[] = [
  { ship: "K-1", market: "X1-A-1", score: 12 },
  { ship: "K-2", market: "X1-A-2", score: 0.1 },
  { ship: "K-3", market: "X1-A-3", score: 40 },
  { ship: "K-4", market: "X1-A-4" },
];
const trades = [trade("X1-A-1", 5, 2), trade("X1-A-2", 0, 3), trade("X1-A-9", 9, 9)];

describe("keeperSales", () => {
  it("lists only keepers whose market saw none of our sales, no-trade markets before buy-only ones", () => {
    const r = keeperSales(keepers, trades);
    assert.equal(r.keepers, 4);
    assert.equal(r.noSales, 3);
    assert.equal(r.noTrade, 2);
    assert.deepEqual(r.rows.map((x) => x.ship), ["K-4", "K-3", "K-2"]);
    assert.equal(r.rows[2]!.buys, 3, "K-2 has no sales but trades are bought there");
  });

  it("orders no-trade markets by score, lowest first, and keeps an unscored keeper first", () => {
    const r = keeperSales([...keepers, { ship: "K-5", market: "X1-A-5", score: 1 }], trades);
    assert.deepEqual(r.rows.slice(0, 3).map((x) => x.ship), ["K-4", "K-5", "K-3"]);
    assert.equal(r.rows[0]!.score, null);
  });

  it("can list every keeper, sales and all, and ignores trades at markets with no keeper", () => {
    const r = keeperSales(keepers, trades, false);
    assert.equal(r.rows.length, 4);
    assert.equal(r.rows.at(-1)!.ship, "K-1");
    assert.equal(r.rows.at(-1)!.sellValue, 5000);
  });
});
