import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTaskSpec, decide } from "../src/engine/openingTasks.js";
import { OpeningRunnerImpl, type OpeningHost } from "../src/engine/openingRunner.js";
import { FleetManager } from "../src/engine/fleet.js";
import {
  describeTask,
  // @ts-expect-error plain browser module, no types
} from "../public/shared/openingPresets.js";

/**
 * 2026-10-25: the gate operation as tasks. `startGateMission` creates (or resumes) the home gate's mission with its pacing in place
 * before any buying; `startFeed` starts a feeder tier with its supply stop. Both are plain steps so a template can carry them.
 */
const spec = (steps: unknown[], trigger: unknown = { kind: "always" }) => ({ key: "g", name: "n", trigger, steps });

describe("validation", () => {
  it("accepts a paused mission with pacing and a feed with limits", () => {
    assert.equal(validateTaskSpec(spec([{ kind: "startGateMission", paused: true, buyLotUnits: 20, buyGapMin: 30, recoverPct: 3, maxInflationPct: 25 }])).ok, true);
    assert.equal(validateTaskSpec(spec([{ kind: "startFeed", waypoint: "X1-BT10-D42", good: "IRON", carrierTarget: 1, stopAtSupply: "HIGH", maxLossPerUnit: 15 }])).ok, true);
  });
  it("a feed can name its crew ship, and only a real symbol", () => {
    const feed = { kind: "startFeed", waypoint: "X1-BT10-F47", good: "IRON", carrier: "THEO-4" };
    assert.equal(validateTaskSpec(spec([feed])).ok, true);
    assert.equal(validateTaskSpec(spec([{ ...feed, carrier: "theo 4" }])).ok, false);
  });
  it("rejects nonsense", () => {
    assert.equal(validateTaskSpec(spec([{ kind: "startGateMission", buyLotUnits: 0 }])).ok, false);
    assert.equal(validateTaskSpec(spec([{ kind: "startGateMission", onlyMaterials: ["fab mats"] }])).ok, false);
    assert.equal(validateTaskSpec(spec([{ kind: "startFeed", waypoint: "bad waypoint", good: "IRON" }])).ok, false);
    assert.equal(validateTaskSpec(spec([{ kind: "startFeed", waypoint: "X1-BT10-D42", good: "IRON", stopAtSupply: "FULL" }])).ok, false);
    assert.equal(validateTaskSpec(spec([{ kind: "startFeed", waypoint: "X1-BT10-D42", good: "IRON", carrierTarget: 99 }])).ok, false);
  });
});

describe("runner", () => {
  it("passes both steps to the host and finishes the task", async () => {
    const calls: unknown[] = [];
    let task: any = { id: 1, key: "k", name: "n", trigger: { kind: "always" }, steps: [{ kind: "startGateMission", paused: true, recoverPct: 3 }, { kind: "startFeed", waypoint: "X1-A-B1", good: "IRON", stopAtSupply: "HIGH", carrier: "T-4" }], status: "queued", stepIndex: 0, stepPhase: "idle", refs: {}, note: null };
    const store: any = { listOpeningTasks: async () => [task], updateOpeningTask: async (_t: string, _i: number, u: any) => { task = { ...task, ...u }; } };
    const host: OpeningHost = {
      spendable: () => 0, ships: () => [], yards: async () => [], bestRouteProfit: () => undefined,
      surveyMissing: async () => ({ total: 0, missing: [], minGoods: 3 }), gateProgress: async () => undefined,
      startGateMission: async (o) => { calls.push(["mission", o.paused, o.recoverPct]); },
      startFeed: async (o) => { calls.push(["feed", o.good, o.stopAtSupply, o.carrier]); },
      buyShip: async () => ({ symbol: "x" }), setRole: async () => {}, setContractDuty: async () => {}, setDoctrine: async () => ({}), log: () => {},
    };
    const r = new OpeningRunnerImpl(store, host);
    for (let i = 0; i < 4; i++) await r.run("t");
    assert.deepEqual(calls, [["mission", true, 3], ["feed", "IRON", "HIGH", "T-4"]]);
    assert.equal(task.status, "done");
    assert.equal(decide({ trigger: task.trigger, steps: task.steps, stepIndex: 0, refs: {} }, { spendable: 0, bestRouteProfit: undefined, ships: [], yards: [], doneKeys: new Set() }).kind, "run");
  });
  it("describes both in plain words", () => {
    const text = describeTask({ trigger: { kind: "always" }, steps: [{ kind: "startGateMission", paused: true, recoverPct: 3 }, { kind: "startFeed", waypoint: "X1-A-B1", good: "IRON", stopAtSupply: "HIGH", carrier: "T-4" }] });
    assert.match(text, /create the home gate mission but keep it paused/);
    assert.match(text, /start a feed of IRON into X1-A-B1, stopping at HIGH supply, crewed by T-4/);
  });
});

describe("FleetManager.startHomeGateMission", () => {
  function fleet(opts: { open?: boolean; gate?: boolean }) {
    const calls: string[] = [];
    const f = new FleetManager({ api: { onMarket: () => {} } as any }) as any;
    f.systemSymbol = "X1-A";
    f.galaxy = { getSystem: () => ({ waypoints: opts.gate === false ? [] : [{ symbol: "X1-A-I1", type: "JUMP_GATE" }] }), gateComplete: () => opts.open === true };
    f.startMission = async (w: string) => { calls.push(`start:${w}`); };
    f.pauseMission = async () => { calls.push("pause"); };
    f.setMissionPacing = async (_w: string, p: unknown) => { calls.push(`pacing:${JSON.stringify(p)}`); };
    f.resumeMission = async () => { calls.push("resume"); };
    return { f, calls };
  }
  it("starts, pauses, sets pacing, then resumes when buying is wanted", async () => {
    const { f, calls } = fleet({});
    await f.startHomeGateMission({ recoverPct: 3, maxInflationPct: 25 });
    assert.deepEqual(calls, ["start:X1-A-I1", "pause", 'pacing:{"recoverPct":3,"maxInflationPct":25}', "resume"]);
  });
  it("paused: true leaves it created and not buying", async () => {
    const { f, calls } = fleet({});
    await f.startHomeGateMission({ paused: true });
    assert.deepEqual(calls, ["start:X1-A-I1", "pause"]);
  });
  it("does nothing once the gate is open, and says so when there is no gate", async () => {
    const open = fleet({ open: true });
    await open.f.startHomeGateMission({});
    assert.deepEqual(open.calls, []);
    await assert.rejects(() => fleet({ gate: false }).f.startHomeGateMission({}), /no jump gate known/);
  });
});
