import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gateProgressPct } from "../src/engine/surveyCoverage.js";
import { triggerMet, validateTaskSpec, type OpeningFacts } from "../src/engine/openingTasks.js";
import { OpeningRunnerImpl, type OpeningHost } from "../src/engine/openingRunner.js";
import { keeperAutoApprove } from "../src/engine/keeperBuy.js";
import { DOCTRINE_CATALOG } from "../src/engine/doctrine.js";
import {
  buildCustomTask, describeTask,
  // @ts-expect-error plain browser module, no types
} from "../public/shared/openingPresets.js";

/**
 * 2026-10-25: early-game limits (cash floor, keeper auto-buy reserve) should loosen at a milestone, and the milestone the operator
 * wants most is the home gate: a trigger on its progress, plus a keeper auto-approve cash reserve that can be switched off then.
 */
const f = (gatePct?: number): OpeningFacts => ({ spendable: 0, bestRouteProfit: undefined, ships: [], yards: [], doneKeys: new Set(), gatePct });

describe("gateProgressAtLeast trigger", () => {
  it("waits until the gate reaches the percentage; 100 means open", () => {
    assert.equal(triggerMet({ kind: "gateProgressAtLeast", pct: 100 }, f(99)).met, false);
    assert.equal(triggerMet({ kind: "gateProgressAtLeast", pct: 100 }, f(100)).met, true);
    assert.equal(triggerMet({ kind: "gateProgressAtLeast", pct: 50 }, f(50)).met, true);
  });
  it("unknown progress is not met", () => {
    assert.equal(triggerMet({ kind: "gateProgressAtLeast", pct: 0 }, f()).met, false);
  });
  it("is validated", () => {
    const ok = { key: "g", name: "n", steps: [{ kind: "setDoctrine", key: "cashFloor", value: 1 }] };
    assert.equal(validateTaskSpec({ ...ok, trigger: { kind: "gateProgressAtLeast", pct: 100 } }).ok, true);
    assert.equal(validateTaskSpec({ ...ok, trigger: { kind: "gateProgressAtLeast", pct: 101 } }).ok, false);
    assert.equal(validateTaskSpec({ ...ok, trigger: { kind: "gateProgressAtLeast", pct: "x" } }).ok, false);
  });
  it("percent rounds down and never reads 100 before the gate says so", () => {
    assert.equal(gateProgressPct(1, 2001), 0);
    assert.equal(gateProgressPct(1000, 2000), 50);
    assert.equal(gateProgressPct(1999, 2000), 99);
    assert.equal(gateProgressPct(2000, 2000), 99);
    assert.equal(gateProgressPct(0, 0), 0);
  });
  it("reads in words and builds from the custom form", () => {
    const spec = buildCustomTask({ name: "open", trigger: { kind: "gateProgressAtLeast", amount: 100 }, steps: [{ kind: "setDoctrine", key: "cashFloor", value: 100000 }] });
    assert.deepEqual(spec.trigger, { kind: "gateProgressAtLeast", pct: 100 });
    assert.match(describeTask(spec), /^When the home gate is open/);
    assert.equal(validateTaskSpec(spec).ok, true);
  });
  it("the runner fires a setDoctrine task when the gate opens and not before", async () => {
    const calls: string[] = [];
    let pct: number | undefined = 40;
    let task: any = { id: 1, key: "k", name: "n", trigger: { kind: "gateProgressAtLeast", pct: 100 }, steps: [{ kind: "setDoctrine", key: "cashFloor", value: 100000 }], status: "queued", stepIndex: 0, stepPhase: "idle", refs: {}, note: null };
    const store: any = { listOpeningTasks: async () => [task], updateOpeningTask: async (_t: string, _i: number, u: any) => { task = { ...task, ...u }; } };
    const host: OpeningHost = {
      spendable: () => 0, ships: () => [], yards: async () => [], bestRouteProfit: () => undefined,
      surveyMissing: async () => ({ total: 0, missing: [], minGoods: 3 }),
      gateProgress: async () => pct,
      startGateMission: async () => {},
      startFeed: async () => {},
      buyShip: async () => ({ symbol: "x" }), setRole: async () => {}, setContractDuty: async () => {},
      setDoctrine: async (k, p) => { calls.push(`${k}:${JSON.stringify(p)}`); return {}; }, log: () => {},
    };
    const r = new OpeningRunnerImpl(store, host);
    await r.run("t"); assert.deepEqual(calls, []);
    pct = 100; await r.run("t");
    assert.deepEqual(calls, ['cashFloor:{"value":100000}']);
    assert.equal(task.status, "done");
  });
});

describe("keeper auto-approve cash reserve", () => {
  const base = { clauseOn: true, capCredits: 60_000, price: 24_000, spendable: true };
  it("asks the operator when paying would leave less than the reserve", () => {
    const r = keeperAutoApprove({ ...base, keepCash: 150_000, credits: 160_000 });
    assert.equal(r.approve, false);
    assert.match(r.reason, /would leave 136000c, under the 150000c to keep/);
  });
  it("approves when the reserve is covered", () => {
    assert.equal(keeperAutoApprove({ ...base, keepCash: 150_000, credits: 174_000 }).approve, true);
  });
  it("is off by default and a 0 or missing reserve changes nothing", () => {
    assert.equal(keeperAutoApprove({ ...base }).approve, true);
    assert.equal(keeperAutoApprove({ ...base, keepCash: 0, credits: 0 }).approve, true);
    const d = DOCTRINE_CATALOG.find((c) => c.key === "keeperAutoApproveMinCash")!;
    assert.equal(d.enabled, false);
  });
});
