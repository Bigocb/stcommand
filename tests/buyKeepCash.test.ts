import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, validateTaskSpec, type OpeningFacts, type TaskSpec } from "../src/engine/openingTasks.js";
import {
  OPENING_PRESETS, describeTask, buildCustomTask,
  // @ts-expect-error plain browser module, no types
} from "../public/shared/openingPresets.js";

/**
 * 2026-10-25: a "buy a shuttle at 110,000 cash" task would have left about 16,000 to trade with. A buy step can now say how much
 * cash must remain after paying, and the presets set it.
 */
const facts = (spendable: number): OpeningFacts => ({
  spendable, bestRouteProfit: 1, doneKeys: new Set(),
  ships: [{ symbol: "T-1", isCommand: true, cargoUnits: 0, waypoint: "Y", docked: true }],
  yards: [{ waypoint: "Y", shipType: "SHIP_LIGHT_SHUTTLE", price: 94_000 }],
});
const task = (keepCash?: number) => ({
  trigger: { kind: "cashAtLeast", credits: 110_000 } as const,
  steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100_000, preApproved: true, ...(keepCash !== undefined ? { keepCash } : {}) }] as TaskSpec["steps"],
  stepIndex: 0, refs: {},
});

describe("buyShip keepCash", () => {
  it("waits when paying would leave less than the reserve, and says by how much", () => {
    const d = decide(task(100_000), facts(110_000));
    assert.equal(d.kind, "wait");
    assert.match((d as any).reason, /would leave 16,000, under the 100,000 to keep/);
  });
  it("buys once the reserve is covered", () => {
    assert.equal(decide(task(100_000), facts(194_000)).kind, "run");
    assert.equal(decide(task(100_000), facts(193_999)).kind, "wait");
  });
  it("without keepCash it behaves as before", () => {
    assert.equal(decide(task(), facts(110_000)).kind, "run");
  });
  it("is validated", () => {
    const base = { key: "k", name: "n", trigger: { kind: "always" }, steps: task(5).steps };
    assert.equal(validateTaskSpec(base).ok, true);
    assert.equal(validateTaskSpec({ ...base, steps: [{ ...task(5).steps[0], keepCash: -1 }] }).ok, false);
    assert.equal(validateTaskSpec({ ...base, steps: [{ ...task(5).steps[0], keepCash: "x" }] }).ok, false);
  });
});

describe("presets and the custom builder set it", () => {
  const defaults = (p: any) => Object.fromEntries(p.fields.map((f: any) => [f.name, f.value]));
  for (const id of ["contract-ship", "tour-ship", "survey-ship", "hauler"]) {
    it(`${id}: buys only with a reserve left, and its start cash covers hull plus reserve`, () => {
      const p = OPENING_PRESETS.find((x: any) => x.id === id);
      const spec = p.build(defaults(p), { existingKeys: [] });
      const buy = spec.steps.find((s: any) => s.kind === "buyShip");
      assert.ok(buy.keepCash >= 100_000);
      assert.ok(validateTaskSpec(spec).ok);
      assert.match(describeTask(spec), /only if 100,000c is left after/);
    });
  }
  it("the custom builder passes it through", () => {
    const spec = buildCustomTask({ name: "x", trigger: { kind: "always" }, steps: [{ kind: "buyShip", shipType: "SHIP_PROBE", maxPrice: 30000, keepCash: 50000 }] });
    assert.equal(spec.steps[0].keepCash, 50000);
  });
});
