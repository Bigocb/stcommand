import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chartPayout, hasSensorArray, summarizeWaypointScan, type ScannedWaypointLike } from "../src/engine/chartProbe.js";

const wp = (symbol: string, over: Partial<ScannedWaypointLike> = {}): ScannedWaypointLike => ({ symbol, type: "PLANET", traits: [{ symbol: "ROCKY" }], ...over });

describe("summarizeWaypointScan", () => {
  it("lists waypoints with no chart as uncharted, with the traits the scan revealed", () => {
    const s = summarizeWaypointScan([wp("X1-A-1", { traits: [{ symbol: "ROCKY" }, { symbol: "MARKETPLACE" }] })], "THEO");
    assert.equal(s.total, 1);
    assert.deepEqual(s.uncharted, [{ symbol: "X1-A-1", type: "PLANET", traits: ["ROCKY", "MARKETPLACE"] }]);
  });
  it("counts charted waypoints by who charted them", () => {
    const s = summarizeWaypointScan(
      [wp("X1-A-1", { chart: { submittedBy: "THEO" } }), wp("X1-A-2", { chart: { submittedBy: "RIVAL" } }), wp("X1-A-3", { chart: { submittedBy: "RIVAL" } })],
      "THEO",
    );
    assert.equal(s.chartedByUs, 1);
    assert.equal(s.chartedByOthers, 2);
    assert.equal(s.uncharted.length, 0);
  });
  it("flags waypoints whose only trait is still UNCHARTED as hidden, and keeps them in the uncharted list without the placeholder", () => {
    const s = summarizeWaypointScan([wp("X1-A-9", { traits: [{ symbol: "UNCHARTED" }] })], "THEO");
    assert.equal(s.stillHidden, 1);
    assert.deepEqual(s.uncharted, [{ symbol: "X1-A-9", type: "PLANET", traits: [] }]);
  });
  it("copes with a missing trait list and an empty scan", () => {
    assert.equal(summarizeWaypointScan([], "THEO").total, 0);
    const s = summarizeWaypointScan([{ symbol: "X1-A-4", type: "MOON" }], "THEO");
    assert.equal(s.stillHidden, 0);
    assert.equal(s.uncharted.length, 1);
  });
});

describe("chartPayout", () => {
  it("reports the balance move across the chart call", () => {
    assert.deepEqual(chartPayout(1_000_000, 1_004_500), { before: 1_000_000, after: 1_004_500, delta: 4_500 });
  });
  it("can go negative when the fleet spent more than the chart paid in the same moment", () => {
    assert.equal(chartPayout(500, 300).delta, -200);
  });
});

describe("hasSensorArray", () => {
  it("accepts any tier of sensor array", () => {
    assert.equal(hasSensorArray([{ symbol: "MOUNT_SENSOR_ARRAY_II" }]), true);
    assert.equal(hasSensorArray([{ symbol: "MOUNT_SENSOR_ARRAY_I" }, { symbol: "MOUNT_TURRET_I" }]), true);
  });
  it("rejects ships without one, or with no mount list", () => {
    assert.equal(hasSensorArray([{ symbol: "MOUNT_MINING_LASER_I" }]), false);
    assert.equal(hasSensorArray(undefined), false);
  });
});
