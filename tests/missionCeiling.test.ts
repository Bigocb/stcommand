import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lotUnitsFor, maxPriceFor, mergeBuyLotUnitsBy, mergeMaxPriceBy } from "../src/engine/missionCeiling.js";
import { validateTaskSpec } from "../src/engine/openingTasks.js";

const MATERIALS = ["FAB_MATS", "ADVANCED_CIRCUITRY", "QUANTUM_STABILIZERS"];

describe("maxPriceFor", () => {
  it("uses the material's own ceiling, then the mission-wide one, then nothing", () => {
    const pacing = { maxPrice: 2000, maxPriceBy: { ADVANCED_CIRCUITRY: 4000 } };
    assert.equal(maxPriceFor(pacing, "ADVANCED_CIRCUITRY"), 4000);
    assert.equal(maxPriceFor(pacing, "FAB_MATS"), 2000);
    assert.equal(maxPriceFor({ maxPriceBy: { ADVANCED_CIRCUITRY: 4000 } }, "FAB_MATS"), undefined);
    assert.equal(maxPriceFor(null, "FAB_MATS"), undefined);
    assert.equal(maxPriceFor(undefined, "FAB_MATS"), undefined);
  });

  it("with no per-material ceilings behaves exactly as maxPrice did", () => {
    assert.equal(maxPriceFor({ maxPrice: 2000 }, "ADVANCED_CIRCUITRY"), 2000);
    assert.equal(maxPriceFor({}, "FAB_MATS"), undefined);
  });
});

describe("mergeMaxPriceBy", () => {
  it("sets, updates and clears single materials and keeps the rest", () => {
    let cur = mergeMaxPriceBy(undefined, { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 }, MATERIALS);
    assert.deepEqual(cur, { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 });
    cur = mergeMaxPriceBy(cur, { ADVANCED_CIRCUITRY: 3800 }, MATERIALS);
    assert.deepEqual(cur, { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 3800 });
    cur = mergeMaxPriceBy(cur, { FAB_MATS: null }, MATERIALS);
    assert.deepEqual(cur, { ADVANCED_CIRCUITRY: 3800 });
    cur = mergeMaxPriceBy(cur, { ADVANCED_CIRCUITRY: 0 }, MATERIALS);
    assert.equal(cur, undefined);
  });

  it("a null patch clears everything; keys are upper-cased", () => {
    assert.equal(mergeMaxPriceBy({ FAB_MATS: 2000 }, null, MATERIALS), undefined);
    assert.deepEqual(mergeMaxPriceBy(undefined, { fab_mats: 1500 }, MATERIALS), { FAB_MATS: 1500 });
  });

  it("rejects a material the mission does not need and an out-of-range price", () => {
    assert.throws(() => mergeMaxPriceBy(undefined, { IRON: 100 }, MATERIALS), /no material IRON/);
    assert.throws(() => mergeMaxPriceBy(undefined, { FAB_MATS: -5 }, MATERIALS), /between 1 and/);
    assert.throws(() => mergeMaxPriceBy(undefined, { FAB_MATS: 200_000_000 }, MATERIALS), /between 1 and/);
  });
});

describe("opening step validation", () => {
  const spec = (maxPriceBy: unknown) => ({ key: "g", name: "n", trigger: { kind: "always" }, steps: [{ kind: "startGateMission", maxPriceBy }] });
  it("accepts per-material ceilings and rejects bad ones", () => {
    assert.equal(validateTaskSpec(spec({ FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 })).ok, true);
    assert.equal(validateTaskSpec(spec({ FAB_MATS: 0 })).ok, false);
    assert.equal(validateTaskSpec(spec({ "fab mats": 5 })).ok, false);
    assert.equal(validateTaskSpec(spec([1])).ok, false);
  });
});

describe("lotUnitsFor", () => {
  it("uses the material's own lot, then the mission-wide one, then nothing", () => {
    const pacing = { buyLotUnits: 40, buyLotUnitsBy: { ADVANCED_CIRCUITRY: 20 } };
    assert.equal(lotUnitsFor(pacing, "ADVANCED_CIRCUITRY"), 20);
    assert.equal(lotUnitsFor(pacing, "FAB_MATS"), 40);
    assert.equal(lotUnitsFor({ buyLotUnitsBy: { ADVANCED_CIRCUITRY: 20 } }, "FAB_MATS"), undefined);
    assert.equal(lotUnitsFor(null, "FAB_MATS"), undefined);
  });
});

describe("mergeBuyLotUnitsBy", () => {
  it("sets, clears and keeps, like the ceilings", () => {
    let cur = mergeBuyLotUnitsBy(undefined, { FAB_MATS: 40, ADVANCED_CIRCUITRY: 20 }, MATERIALS);
    assert.deepEqual(cur, { FAB_MATS: 40, ADVANCED_CIRCUITRY: 20 });
    cur = mergeBuyLotUnitsBy(cur, { ADVANCED_CIRCUITRY: null }, MATERIALS);
    assert.deepEqual(cur, { FAB_MATS: 40 });
    assert.equal(mergeBuyLotUnitsBy(cur, null, MATERIALS), undefined);
  });
  it("rejects an unknown material and a lot outside 1 to 1,000", () => {
    assert.throws(() => mergeBuyLotUnitsBy(undefined, { IRON: 5 }, MATERIALS), /buyLotUnitsBy: the mission has no material IRON/);
    assert.throws(() => mergeBuyLotUnitsBy(undefined, { FAB_MATS: 5000 }, MATERIALS), /between 1 and 1,000/);
    assert.throws(() => mergeBuyLotUnitsBy(undefined, { FAB_MATS: -1 }, MATERIALS), /between 1 and 1,000/);
  });
});

describe("opening step validation: buyLotUnitsBy", () => {
  const spec = (buyLotUnitsBy: unknown) => ({ key: "g", name: "n", trigger: { kind: "always" }, steps: [{ kind: "startGateMission", buyLotUnitsBy }] });
  it("accepts per-material lots and rejects bad ones", () => {
    assert.equal(validateTaskSpec(spec({ FAB_MATS: 40, ADVANCED_CIRCUITRY: 20 })).ok, true);
    assert.equal(validateTaskSpec(spec({ FAB_MATS: 0 })).ok, false);
    assert.equal(validateTaskSpec(spec({ FAB_MATS: 1001 })).ok, false);
    assert.equal(validateTaskSpec(spec({ "fab mats": 5 })).ok, false);
  });
});
