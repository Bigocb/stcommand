import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { shareGoods, sortFieldRows, heat } from "../public/shared/miningSort.js";

const row = (waypoint: string, surveys: number, shares: { good: string; percent: number }[], extra: Record<string, unknown> = {}) => ({
  waypoint, surveys, shares, surveyed: surveys > 0, miners: [], ...extra,
});
const rows = [
  row("B", 12, [{ good: "COPPER_ORE", percent: 50 }, { good: "IRON_ORE", percent: 25 }], { distanceToTarget: 80, miners: ["M-1", "M-2"] }),
  row("A", 3, [{ good: "IRON_ORE", percent: 60 }], { distanceToTarget: 20 }),
  row("C", 0, [], { distanceToTarget: 50 }),
];

describe("mining fields table helpers", () => {
  it("gives a column to every good seen, the biggest total share first", () => {
    assert.deepEqual(shareGoods(rows), ["IRON_ORE", "COPPER_ORE"]);
  });
  it("sorts by surveys, distance, miners and name, in either direction", () => {
    assert.deepEqual(sortFieldRows(rows, "surveys", "desc").map((r: { waypoint: string }) => r.waypoint), ["B", "A", "C"]);
    assert.deepEqual(sortFieldRows(rows, "distance", "asc").map((r: { waypoint: string }) => r.waypoint), ["A", "C", "B"]);
    assert.deepEqual(sortFieldRows(rows, "miners", "desc").map((r: { waypoint: string }) => r.waypoint)[0], "B");
    assert.deepEqual(sortFieldRows(rows, "waypoint", "asc").map((r: { waypoint: string }) => r.waypoint), ["A", "B", "C"]);
  });
  it("sorts a share column with never-surveyed fields last either way", () => {
    assert.deepEqual(sortFieldRows(rows, "share:IRON_ORE", "desc").map((r: { waypoint: string }) => r.waypoint), ["A", "B", "C"]);
    assert.deepEqual(sortFieldRows(rows, "share:IRON_ORE", "asc").map((r: { waypoint: string }) => r.waypoint), ["B", "A", "C"]);
  });
  it("does not change the rows it is given, and caps the heat", () => {
    const copy = JSON.stringify(rows);
    sortFieldRows(rows, "surveys", "asc");
    assert.equal(JSON.stringify(rows), copy);
    assert.ok(heat(100) <= 0.55 && heat(0) === 0);
  });
});
