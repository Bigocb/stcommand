import { test } from "node:test";
import assert from "node:assert/strict";
import { missionYieldView, mayRelease, mayTake, YIELD_MIN_HOLD_MS, YIELD_MIN_FREE_MS } from "../src/engine/missionYield.js";

const mats = [
  { tradeSymbol: "FAB_MATS", required: 1600, fulfilled: 220 },
  { tradeSymbol: "ADVANCED_CIRCUITRY", required: 400, fulfilled: 0 },
  { tradeSymbol: "QUANTUM_STABILIZERS", required: 1, fulfilled: 1 },
];
const pacing = { maxPrice: 2000, maxPriceBy: { ADVANCED_CIRCUITRY: 4000 } };

test("runs when either material is at or under its own ceiling", () => {
  const v = missionYieldView(mats, pacing, [{ material: "FAB_MATS", ask: 2485 }, { material: "ADVANCED_CIRCUITRY", ask: 4000 }]);
  assert.equal(v.decision, "run");
  assert.match(v.reason, /ADVANCED_CIRCUITRY 4,000 within 4,000/);
});

test("yields only when every outstanding material is over its ceiling", () => {
  const v = missionYieldView(mats, pacing, [{ material: "FAB_MATS", ask: 2485 }, { material: "ADVANCED_CIRCUITRY", ask: 4900 }]);
  assert.equal(v.decision, "yield");
  assert.equal(v.reason, "FAB_MATS 2,485 over 2,000; ADVANCED_CIRCUITRY 4,900 over 4,000");
});

test("a missing price never releases the carrier", () => {
  const v = missionYieldView(mats, pacing, [{ material: "FAB_MATS", ask: 2485 }, { material: "ADVANCED_CIRCUITRY", ask: undefined }]);
  assert.equal(v.decision, "hold");
});

test("a fulfilled material and one outside onlyMaterials are not considered", () => {
  const v = missionYieldView(mats, { ...pacing, onlyMaterials: ["FAB_MATS"] }, [{ material: "FAB_MATS", ask: 2485 }, { material: "ADVANCED_CIRCUITRY", ask: 100 }]);
  assert.equal(v.decision, "yield");
  assert.doesNotMatch(v.reason, /ADVANCED/);
});

test("a material with no absolute ceiling counts as buyable", () => {
  assert.equal(missionYieldView(mats, null, [{ material: "FAB_MATS", ask: 99999 }]).decision, "run");
});

test("nothing outstanding runs", () => {
  assert.equal(missionYieldView([{ tradeSymbol: "X", required: 1, fulfilled: 1 }], pacing, []).decision, "run");
});

test("hold and free times", () => {
  assert.equal(mayRelease(YIELD_MIN_HOLD_MS - 1, 0), false);
  assert.equal(mayRelease(YIELD_MIN_HOLD_MS, 0), true);
  assert.equal(mayTake(1000, undefined), true);
  assert.equal(mayTake(YIELD_MIN_FREE_MS - 1, 0), false);
  assert.equal(mayTake(YIELD_MIN_FREE_MS, 0), true);
});
