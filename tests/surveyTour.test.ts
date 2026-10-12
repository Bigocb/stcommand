import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextTourStep, orderNearest, startNextLap, type SurveyTourPlan } from "../src/engine/surveyTour.js";

const plan = (over: Partial<SurveyTourPlan> = {}): SurveyTourPlan => ({ fields: ["A", "B"], perField: 2, loop: false, laps: 0, done: new Map(), ...over });

describe("nextTourStep", () => {
  it("surveys the first field still short of its batches, in order", () => {
    const p = plan();
    assert.deepEqual(nextTourStep(p), { kind: "survey", field: "A" });
    p.done.set("A", 2);
    assert.deepEqual(nextTourStep(p), { kind: "survey", field: "B" });
    p.done.set("B", 1);
    assert.deepEqual(nextTourStep(p), { kind: "survey", field: "B" });
  });
  it("a single pass completes once every field has its batches", () => {
    const p = plan();
    p.done.set("A", 2); p.done.set("B", 2);
    assert.deepEqual(nextTourStep(p), { kind: "complete" });
  });
  it("a looping tour finishes the lap instead, and the next lap starts clean", () => {
    const p = plan({ loop: true });
    p.done.set("A", 2); p.done.set("B", 2);
    assert.deepEqual(nextTourStep(p), { kind: "lap", laps: 1 });
    startNextLap(p);
    assert.equal(p.laps, 1);
    assert.deepEqual(nextTourStep(p), { kind: "survey", field: "A" });
  });
});

describe("orderNearest", () => {
  const coords = new Map([["A", { x: 0, y: 0 }], ["B", { x: 100, y: 0 }], ["C", { x: 10, y: 0 }], ["D", { x: 55, y: 0 }]]);
  it("always goes to the nearest field not yet visited", () => {
    assert.deepEqual(orderNearest(["B", "D", "A", "C"], coords, { x: 0, y: 0 }), ["A", "C", "D", "B"]);
  });
  it("keeps the given order when no start is known, drops duplicates, and tolerates unknown fields", () => {
    assert.deepEqual(orderNearest(["B", "A", "B"], coords), ["B", "A"]);
    assert.deepEqual(orderNearest(["X", "A"], coords, { x: 0, y: 0 }), ["A", "X"]);
  });
});
