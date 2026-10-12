import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { miningFieldsReport, type FieldSurveyTally, type FieldWaypoint } from "../src/engine/miningFields.js";

const wps: FieldWaypoint[] = [
  { symbol: "X1-A-H57", x: 0, y: 0, type: "PLANET" },
  { symbol: "X1-A-NEAR", x: 30, y: 40, type: "ASTEROID", traits: ["COMMON_METAL_DEPOSITS"] },
  { symbol: "X1-A-FAR", x: 300, y: 400, type: "ENGINEERED_ASTEROID", traits: ["STRIPPED"] },
  { symbol: "X1-A-BASE", x: 5, y: 5, type: "ASTEROID_BASE" },
];
const tallies: FieldSurveyTally[] = [
  { waypointSymbol: "X1-A-NEAR", surveys: 12, deposits: 40, counts: { IRON_ORE: 10, COPPER_ORE: 20, ICE_WATER: 10 } },
  { waypointSymbol: "X1-A-FAR", surveys: 3, deposits: 20, counts: { COPPER_ORE: 18, IRON_ORE: 2 } },
];

describe("miningFieldsReport", () => {
  it("lists only minable waypoints, nearest first, with percent shares largest first", () => {
    const rows = miningFieldsReport({ waypoints: wps, tallies, pins: [], feeds: [], target: "X1-A-H57" });
    assert.deepEqual(rows.map((r) => r.waypoint), ["X1-A-NEAR", "X1-A-FAR"]);
    assert.equal(rows[0]!.distanceToTarget, 50);
    assert.deepEqual(rows[0]!.shares, [{ good: "COPPER_ORE", percent: 50 }, { good: "ICE_WATER", percent: 25 }, { good: "IRON_ORE", percent: 25 }]);
  });
  it("ranks by a named good's share and flags thin survey counts", () => {
    const rows = miningFieldsReport({ waypoints: wps, tallies, pins: [], feeds: [], target: "X1-A-H57", good: "copper_ore" });
    assert.deepEqual(rows.map((r) => [r.waypoint, r.goodShare, r.reliable]), [["X1-A-FAR", 90, false], ["X1-A-NEAR", 50, true]]);
  });
  it("shows a never-surveyed field as unsurveyed, and who is working each field", () => {
    const rows = miningFieldsReport({
      waypoints: [...wps, { symbol: "X1-A-NEW", x: 1, y: 1, type: "ASTEROID" }],
      tallies, target: "X1-A-H57",
      pins: [{ ship: "M-2", field: "X1-A-NEAR" }, { ship: "M-1", field: "X1-A-NEAR" }],
      feeds: [{ good: "COPPER_ORE", targetWaypoint: "X1-A-H57", field: "X1-A-NEAR", collector: "C-1" }],
    });
    const fresh = rows.find((r) => r.waypoint === "X1-A-NEW")!;
    assert.equal(fresh.surveyed, false);
    assert.deepEqual(fresh.shares, []);
    const near = rows.find((r) => r.waypoint === "X1-A-NEAR")!;
    assert.deepEqual(near.miners, ["M-1", "M-2"]);
    assert.deepEqual(near.feeds, [{ good: "COPPER_ORE", target: "X1-A-H57", collector: "C-1" }]);
  });
});
