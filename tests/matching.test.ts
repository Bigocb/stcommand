import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitValue, matchShips, type MatchItem, type MatchShip } from "../src/engine/matching.js";

const item = (key: string, profit: number, extra: Partial<MatchItem> = {}): MatchItem => ({ key, profitPerTrip: profit, rawProfit: profit, tripSeconds: 600, ...extra });
const ship = (shipSymbol: string, capacity: number): MatchShip => ({ shipSymbol, capacity });
const never = { positioningSeconds: () => 0 };

describe("matching: fitValue", () => {
  it("uses the profit priced at the ship's own hold", () => {
    const i = item("A", 60_000, { profitByHold: { "40": 15_000, "150": 60_000 } });
    assert.equal(fitValue(i, ship("S", 40), 0), 15_000);
    assert.equal(fitValue(i, ship("B", 150), 0), 60_000);
  });
  it("falls back to hold / volume when the hold has no priced entry", () => {
    const i = item("A", 60_000, { volume: 150 });
    assert.equal(fitValue(i, ship("S", 75), 0), 30_000);
    assert.equal(fitValue(i, ship("S", 300), 0), 60_000); // never more than the route's own profit
  });
  it("charges the time to reach the buy market against the trip", () => {
    const i = item("A", 60_000);
    assert.equal(fitValue(i, ship("S", 40), 600), 30_000);
  });
});

describe("matching: matchShips", () => {
  it("topN 0 matches nothing", () => {
    const r = matchShips([item("A", 1)], [ship("S", 40)], never, { topN: 0 });
    assert.deepEqual(r.order, []);
    assert.deepEqual(r.notes, []);
  });
  it("gives each route, best first, the ship that earns most from it, using each ship once", () => {
    const a = item("A", 60_000, { profitByHold: { "40": 60_000, "150": 60_000 } });
    const b = item("B", 50_000, { profitByHold: { "40": 15_000, "150": 50_000 } });
    const near = (s: MatchShip, i: MatchItem) => (s.shipSymbol === "BIG" && i.key === "A" ? 300 : 0);
    const r = matchShips([a, b], [ship("BIG", 150), ship("SMALL", 40)], { positioningSeconds: near }, { topN: 2 });
    assert.deepEqual(r.order, ["SMALL", "BIG"]);
    assert.match(r.notes[0]!, /A -> SMALL/);
    assert.match(r.notes[1]!, /B -> BIG/);
  });
  it("breaks a tie toward the bigger hold", () => {
    const a = item("A", 60_000, { profitByHold: { "40": 60_000, "150": 60_000 } });
    const r = matchShips([a], [ship("SMALL", 40), ship("BIG", 150)], never, { topN: 1 });
    assert.deepEqual(r.order, ["BIG"]);
  });
  it("skips a route nobody can take and only matches the top N", () => {
    const a = item("A", 9), b = item("B", 8), c = item("C", 7);
    const can = (_s: MatchShip, i: MatchItem) => (i.key === "A" ? undefined : 0);
    const r = matchShips([a, b, c], [ship("S1", 40), ship("S2", 40)], { positioningSeconds: can }, { topN: 2 });
    assert.equal(r.order.length, 1); // A skipped, B matched, C is beyond the top 2
    assert.match(r.notes[0]!, /B -> S1/);
  });
});
