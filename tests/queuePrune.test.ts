import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { systemsToDrop, type PruneFacts } from "../src/engine/queuePrune.js";

const f = (system: string, o: Partial<PruneFacts> = {}): PruneFacts => ({ system, state: "scouted", held: false, shipyards: 0, uncharted: 0, ...o });

describe("systemsToDrop", () => {
  it("drops a scouted system with no shipyard", () => {
    assert.deepEqual(systemsToDrop([f("X1-A")], 1), [{ system: "X1-A", reason: "0 shipyard(s), needs 1" }]);
  });
  it("keeps a system with a shipyard", () => {
    assert.deepEqual(systemsToDrop([f("X1-A", { shipyards: 1 })], 1), []);
  });
  it("never drops a staged, live or held system", () => {
    assert.deepEqual(systemsToDrop([f("X1-A", { state: "staged" }), f("X1-B", { state: "live" }), f("X1-C", { held: true })], 1), []);
  });
  it("keeps a system with an uncharted waypoint, where a yard may hide", () => {
    assert.deepEqual(systemsToDrop([f("X1-A", { uncharted: 2 })], 1), []);
  });
  it("drops nothing on unknown waypoints", () => {
    assert.deepEqual(systemsToDrop([{ system: "X1-A", state: "scouted", held: false }], 1), []);
  });
  it("a minimum of 0 (clause off) drops nothing", () => {
    assert.deepEqual(systemsToDrop([f("X1-A")], 0), []);
  });
});
