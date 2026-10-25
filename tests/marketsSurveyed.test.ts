import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unpricedMarkets } from "../src/engine/surveyCoverage.js";
import { decide, triggerMet, validateTaskSpec, type OpeningFacts, type TaskSpec } from "../src/engine/openingTasks.js";
import { OpeningRunnerImpl, type OpeningHost } from "../src/engine/openingRunner.js";

/**
 * 2026-10-25: the operator wanted a tour ship bought to price the rest of the home system's markets, and once every market with at
 * least the keeper minimum of goods is priced, that same ship to become a trader. That needs a trigger on market coverage and a way
 * to wait part-way through one task (the ship is only known by the step that bought it).
 */

describe("unpricedMarkets", () => {
  const goods = new Map([["A", 6], ["B", 2], ["C", 4], ["D", 5]]);
  it("counts only markets with enough goods and lists those with no price yet", () => {
    const r = unpricedMarkets(["A", "B", "C", "D"], (m) => goods.get(m), new Set(["A"]), 3);
    assert.deepEqual(r, { total: 3, missing: ["C", "D"] });
  });
  it("a market whose goods are not known yet is not dropped on a guess", () => {
    const r = unpricedMarkets(["A", "X"], (m) => goods.get(m), new Set(["A"]), 3);
    assert.deepEqual(r, { total: 2, missing: ["X"] });
  });
  it("is empty when everything worth it is priced", () => {
    assert.deepEqual(unpricedMarkets(["A", "B"], (m) => goods.get(m), new Set(["A"]), 3), { total: 1, missing: [] });
  });
});

function facts(over: Partial<OpeningFacts> = {}): OpeningFacts {
  return { spendable: 500_000, bestRouteProfit: 1, ships: [{ symbol: "T-1", isCommand: true, cargoUnits: 0, waypoint: "W", docked: true }, { symbol: "T-9", isCommand: false, cargoUnits: 0, waypoint: "W", docked: true }], yards: [], doneKeys: new Set(), ...over };
}

const SPEC: TaskSpec = {
  key: "survey-ship",
  name: "Tour ship that becomes a trader",
  trigger: { kind: "cashAtLeast", credits: 110_000 },
  steps: [
    { kind: "buyShip", shipType: "SHIP_LIGHT_SHUTTLE", maxPrice: 100_000, preApproved: true },
    { kind: "setRole", ship: { by: "step", step: 0 }, role: "tour" },
    { kind: "waitFor", trigger: { kind: "marketsSurveyed" } },
    { kind: "setRole", ship: { by: "step", step: 0 }, role: "trader" },
  ],
};

describe("marketsSurveyed trigger", () => {
  it("waits while markets are unpriced and says which", () => {
    const r = triggerMet({ kind: "marketsSurveyed" }, facts({ surveyMissing: { total: 5, missing: ["M1", "M2"], minGoods: 3 } }));
    assert.equal(r.met, false);
    assert.match(r.reason, /2 of 5 markets with 3\+ goods still unpriced \(M1, M2\)/);
  });
  it("is met when none are missing, but not on an empty or unknown system", () => {
    assert.equal(triggerMet({ kind: "marketsSurveyed" }, facts({ surveyMissing: { total: 5, missing: [], minGoods: 3 } })).met, true);
    assert.equal(triggerMet({ kind: "marketsSurveyed" }, facts({ surveyMissing: { total: 0, missing: [], minGoods: 3 } })).met, false);
    assert.equal(triggerMet({ kind: "marketsSurveyed" }, facts()).met, false);
  });
});

describe("waitFor step", () => {
  const at = (stepIndex: number, f: OpeningFacts) => decide({ trigger: SPEC.trigger, steps: SPEC.steps, stepIndex, refs: { "0": "T-9" } }, f);
  it("holds the task at that step until the trigger is met, then lets it run", () => {
    assert.equal(at(2, facts({ surveyMissing: { total: 3, missing: ["M"], minGoods: 3 } })).kind, "wait");
    assert.equal(at(2, facts({ surveyMissing: { total: 3, missing: [], minGoods: 3 } })).kind, "run");
  });
  it("validates, including a template of this task", () => {
    assert.equal(validateTaskSpec(SPEC).ok, true);
    assert.equal(validateTaskSpec({ ...SPEC, steps: [{ kind: "waitFor", trigger: { kind: "nope" } }] }).ok, false);
  });
});

describe("runner, end to end", () => {
  it("buys, tours, waits for coverage, then makes the same ship a trader", async () => {
    const calls: string[] = [];
    let missing = ["M1"];
    let task = { ...SPEC, id: 1, status: "queued" as string, stepIndex: 0, stepPhase: "idle" as const, refs: {} as Record<string, string>, note: null as string | null };
    const store: any = {
      listOpeningTasks: async () => [task],
      updateOpeningTask: async (_t: string, _id: number, u: any) => { task = { ...task, ...u }; },
    };
    const host: OpeningHost = {
      spendable: () => 500_000,
      ships: () => [
        { symbol: "T-1", isCommand: true, cargoUnits: 0, waypoint: "Y", docked: true },
        { symbol: "T-9", isCommand: false, cargoUnits: 0, waypoint: "Y", docked: true },
      ],
      yards: async () => [{ waypoint: "Y", shipType: "SHIP_LIGHT_SHUTTLE", price: 85_000 }],
      bestRouteProfit: () => 1,
      surveyMissing: async () => ({ total: 4, missing, minGoods: 3 }),
      gateProgress: async () => undefined,
      buyShip: async () => { calls.push("buy"); return { symbol: "T-9" }; },
      setRole: async (s, r) => { calls.push(`role:${s}:${r}`); },
      setContractDuty: async () => {},
      setDoctrine: async () => ({}),
      log: () => {},
    };
    const runner = new OpeningRunnerImpl(store, host);
    for (let i = 0; i < 6; i++) await runner.run("t");
    assert.deepEqual(calls, ["buy", "role:T-9:tour"], "stops at the wait while a market is unpriced");
    assert.equal(task.stepIndex, 2);
    missing = [];
    for (let i = 0; i < 4; i++) await runner.run("t");
    assert.deepEqual(calls, ["buy", "role:T-9:tour", "role:T-9:trader"]);
    assert.equal(task.status, "done");
  });
});
