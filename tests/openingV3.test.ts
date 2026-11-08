import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db/store.js";
import { OpeningRunnerImpl, type OpeningHost, type OpeningShipFacts } from "../src/engine/openingRunner.js";
import {
  decide, instantiateTemplate, triggerMet, validateTaskSpec, validateTemplateTasks,
  type OpeningFacts, type TaskRun, type TaskSpec, type Trigger,
} from "../src/engine/openingTasks.js";
import { OPENING_V3, GATE_CEILINGS } from "../src/engine/openingTemplates.js";
import { ResetWatcher, type ResetWatcherPorts } from "../src/engine/resetWatcher.js";

const T0 = Date.parse("2026-11-08T13:00:00Z");
const facts = (over: Partial<OpeningFacts> = {}): OpeningFacts => ({
  nowMs: T0, spendable: 175_000, bestRouteProfit: undefined, ships: [{ symbol: "THEO-1", isCommand: true, cargoUnits: 0, waypoint: "X1-AA1-A1", docked: true }],
  yards: [], doneKeys: new Set(), ...over,
});

describe("new triggers: any and minutesSinceQueued", () => {
  const trig: Trigger = { kind: "any", of: [{ kind: "routeProfitAtLeast", profitPerTrip: 15000 }, { kind: "minutesSinceQueued", minutes: 30 }] };
  it("any: met by the first member that is, and says why when none is", () => {
    assert.equal(triggerMet(trig, facts({ bestRouteProfit: 20000 }), T0).met, true);
    const early = triggerMet(trig, facts({ bestRouteProfit: 9000, nowMs: T0 + 10 * 60_000 }), T0);
    assert.equal(early.met, false);
    assert.match(early.reason, /none of/);
    assert.equal(triggerMet(trig, facts({ nowMs: T0 + 31 * 60_000 }), T0).met, true, "the 30 minute backstop");
  });
  it("minutesSinceQueued is never met without a queue time or a clock", () => {
    assert.equal(triggerMet({ kind: "minutesSinceQueued", minutes: 1 }, facts(), undefined).met, false);
    assert.equal(triggerMet({ kind: "minutesSinceQueued", minutes: 1 }, { ...facts(), nowMs: undefined }, T0).met, false);
  });
  it("decide() reads the queue time from the task", () => {
    const task = { trigger: trig, steps: [{ kind: "setRole", ship: { by: "command" }, role: "trader" }] as TaskSpec["steps"], stepIndex: 0, refs: {}, createdAt: new Date(T0).toISOString() };
    assert.equal(decide(task, facts({ nowMs: T0 + 5 * 60_000 })).kind, "wait");
    assert.equal(decide(task, facts({ nowMs: T0 + 31 * 60_000 })).kind, "run");
  });
  it("validation: any needs members, cannot nest any, may sit inside all; minutes are bounded", () => {
    const ok = (trigger: unknown) => validateTaskSpec({ key: "k", name: "n", trigger, steps: [{ kind: "setDoctrine", key: "cashFloor", value: 1 }] });
    assert.equal(ok(trig).ok, true);
    assert.equal(ok({ kind: "any", of: [] }).ok, false);
    assert.equal(ok({ kind: "any", of: [{ kind: "any", of: [{ kind: "always" }] }] }).ok, false);
    assert.equal(ok({ kind: "all", of: [trig, { kind: "cashAtLeast", credits: 1 }] }).ok, true);
    assert.equal(ok({ kind: "minutesSinceQueued", minutes: -1 }).ok, false);
    assert.equal(ok({ kind: "minutesSinceQueued", minutes: 99999 }).ok, false);
  });
});

describe("new steps: gateCrew and keepers", () => {
  const spec = (steps: unknown[]) => validateTaskSpec({ key: "k", name: "n", trigger: { kind: "always" }, steps });
  it("gateCrew takes a ship ref, including the ship an earlier buyShip step bought", () => {
    assert.equal(spec([{ kind: "buyShip", shipType: "SHIP_LIGHT_HAULER", maxPrice: 1, preApproved: true }, { kind: "gateCrew", ship: { by: "step", step: 0 } }]).ok, true);
    assert.equal(spec([{ kind: "gateCrew", ship: { by: "step", step: 0 } }]).ok, false, "no earlier buy to point at");
    assert.equal(spec([{ kind: "gateCrew" }]).ok, false);
  });
  it("keepers takes a scope and an optional count", () => {
    assert.equal(spec([{ kind: "keepers", scope: "shipyards" }]).ok, true);
    assert.equal(spec([{ kind: "keepers", scope: "top", count: 10 }]).ok, true);
    assert.equal(spec([{ kind: "keepers", scope: "everything" }]).ok, false);
    assert.equal(spec([{ kind: "keepers", scope: "top", count: 0 }]).ok, false);
  });
  it("a setRole on the command ship waits (not fails) while the fleet is still empty after a reset", () => {
    const task = { trigger: { kind: "always" } as const, steps: [{ kind: "setRole", ship: { by: "command" }, role: "tour" }] as TaskSpec["steps"], stepIndex: 0, refs: {} };
    assert.equal(decide(task, facts({ ships: [] })).kind, "wait");
    assert.equal(decide(task, facts()).kind, "run");
    const bySymbol = { ...task, steps: [{ kind: "setRole", ship: { by: "symbol", symbol: "THEO-9" }, role: "tour" }] as TaskSpec["steps"] };
    assert.equal(decide(bySymbol, facts()).kind, "fail", "a named ship that is not there is still a failure");
  });
});

describe("Opening v3 and instantiateTemplate", () => {
  it("the template is valid, every task fits the step limit, and the ceilings are the operator's", () => {
    assert.equal(validateTemplateTasks(OPENING_V3).ok, true);
    assert.equal(OPENING_V3.length, 10);
    assert.deepEqual(GATE_CEILINGS, { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 });
    const gate = OPENING_V3.find((t) => t.key === "o3-gatemission")!.steps[0] as { maxPriceBy?: Record<string, number>; paused?: boolean };
    assert.deepEqual(gate.maxPriceBy, { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 });
    assert.equal(gate.paused, true, "the mission is created paused");
    const haul = OPENING_V3.find((t) => t.key === "o3-gatehaul")!.steps.find((s) => s.kind === "startGateMission") as { maxPriceBy?: Record<string, number>; paused?: boolean };
    assert.equal(haul.paused, false);
    assert.deepEqual(haul.maxPriceBy, { FAB_MATS: 2000, ADVANCED_CIRCUITRY: 4000 }, "buying starts with the same ceilings");
  });
  it("the order is the operator's: tour, trade, 200k yard keepers, 200k contract shuttle, 1M top keepers, 1M gate hauler", () => {
    const by = Object.fromEntries(OPENING_V3.map((t) => [t.key, t]));
    assert.deepEqual(by["o3-tour"]!.steps[0], { kind: "setRole", ship: { by: "command" }, role: "tour" });
    assert.deepEqual(by["o3-yardkeep"]!.trigger, { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-trader" }, { kind: "cashAtLeast", credits: 200000 }] });
    assert.deepEqual(by["o3-contract"]!.trigger, { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-yardkeep" }, { kind: "cashAtLeast", credits: 200000 }] });
    assert.deepEqual(by["o3-topkeep"]!.trigger, { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-contract" }, { kind: "cashAtLeast", credits: 1000000 }] });
    assert.deepEqual(by["o3-gatehaul"]!.trigger, { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-topkeep" }, { kind: "cashAtLeast", credits: 1000000 }] });
    assert.deepEqual(by["o3-yardkeep"]!.steps, [{ kind: "keepers", scope: "shipyards" }]);
  });
  it("instantiate: every key gets the suffix, taskDone references follow, and the result is valid", () => {
    const r = instantiateTemplate(OPENING_V3, "1108");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.value.every((t) => t.key.endsWith("-1108") && t.key.length <= 24));
    const yard = r.value.find((t) => t.key === "o3-yardkeep-1108")!;
    assert.deepEqual(yard.trigger, { kind: "all", of: [{ kind: "taskDone", taskKey: "o3-trader-1108" }, { kind: "cashAtLeast", credits: 200000 }] });
    assert.equal(OPENING_V3.find((t) => t.key === "o3-yardkeep")!.key, "o3-yardkeep", "the saved template is not changed");
  });
  it("instantiate refuses a bad suffix or one that pushes a key past 24 characters", () => {
    assert.equal(instantiateTemplate(OPENING_V3, "Nov 8").ok, false);
    assert.equal(instantiateTemplate(OPENING_V3, "").ok, false);
    const long: TaskSpec[] = [{ key: "a".repeat(22), name: "n", trigger: { kind: "always" }, steps: [{ kind: "setDoctrine", key: "cashFloor", value: 1 }] }];
    assert.equal(instantiateTemplate(long, "1108").ok, false);
  });
  it("simulated morning: the sequence unlocks in the operator's order as cash grows", () => {
    const inst = instantiateTemplate(OPENING_V3, "1108");
    assert.ok(inst.ok);
    if (!inst.ok) return;
    const done = new Set<string>();
    const created = new Date(T0).toISOString();
    const eligible = (cash: number, minutes: number, route?: number, extra: Partial<OpeningFacts> = {}) =>
      inst.value.filter((t) => !done.has(t.key) && decide({ ...t, stepIndex: 0, refs: {}, createdAt: created }, facts({ spendable: cash, nowMs: T0 + minutes * 60_000, bestRouteProfit: route, doneKeys: done, ...extra })).kind !== "wait").map((t) => t.key);
    assert.deepEqual(eligible(175_000, 0), ["o3-tour-1108", "o3-start-1108", "o3-gatemission-1108"], "at the start: tour, settings, gate mission");
    ["o3-tour-1108", "o3-start-1108", "o3-gatemission-1108"].forEach((k) => done.add(k));
    assert.deepEqual(eligible(175_000, 10, 8000), [], "no good route yet, under 30 minutes: nothing");
    assert.deepEqual(eligible(175_000, 12, 16000), ["o3-trader-1108"], "a 16k route sends the command ship trading");
    assert.deepEqual(eligible(175_000, 31, 8000), ["o3-trader-1108"], "or 30 minutes do");
    done.add("o3-trader-1108");
    assert.deepEqual(eligible(190_000, 40), [], "below 200k the yard keepers wait");
    assert.deepEqual(eligible(210_000, 45), ["o3-yardkeep-1108"]);
    done.add("o3-yardkeep-1108");
    assert.deepEqual(eligible(120_000, 50), [], "after the keepers cost cash, the shuttle waits for 200k again");
    assert.deepEqual(eligible(205_000, 60, undefined, { yards: [{ waypoint: "Y", shipType: "SHIP_LIGHT_SHUTTLE", price: 90_000 }], ships: [{ symbol: "THEO-1", isCommand: true, cargoUnits: 0, waypoint: "Y", docked: true }] }), ["o3-contract-1108"]);
    done.add("o3-contract-1108");
    assert.deepEqual(eligible(900_000, 300), [], "under 1M the top keepers wait");
    assert.deepEqual(eligible(1_050_000, 320), ["o3-topkeep-1108"]);
    done.add("o3-topkeep-1108");
    assert.deepEqual(eligible(800_000, 340), [], "back under 1M after the keepers: the hauler waits");
    assert.deepEqual(eligible(1_020_000, 360, undefined, { yards: [{ waypoint: "Y", shipType: "SHIP_LIGHT_HAULER", price: 325_000 }], ships: [{ symbol: "THEO-1", isCommand: true, cargoUnits: 0, waypoint: "Y", docked: true }] }), ["o3-gatehaul-1108"]);
    assert.deepEqual(eligible(5_000_000, 900, undefined, { gatePct: 86 }).includes("o3-finalpush-1108"), true);
    assert.deepEqual(eligible(5_000_000, 900, undefined, { gatePct: 100 }).includes("o3-gateopen-1108"), true);
  });
});

// ---- the runner ----
class MockStore extends Store {
  updates: { id: number; updates: Record<string, unknown> }[] = [];
  constructor(private readonly rows: TaskRun[]) { super({} as never); }
  async listOpeningTasks(_t: string): Promise<TaskRun[]> { return this.rows; }
  async updateOpeningTask(_t: string, id: number, updates: Partial<TaskRun>): Promise<void> { this.updates.push({ id, updates: updates as Record<string, unknown> }); }
}
const SHIPS: OpeningShipFacts[] = [{ symbol: "THEO-1", isCommand: true, cargoUnits: 0, waypoint: "A", docked: true }, { symbol: "THEO-9", isCommand: false, cargoUnits: 0, waypoint: "A", docked: true }];
const runTask = (over: Partial<TaskRun> & Pick<TaskRun, "steps">): TaskRun => ({ id: 1, key: "t", name: "t", trigger: { kind: "always" }, status: "queued", stepIndex: 0, stepPhase: "idle", refs: {}, note: null, ...over });
function host(over: Partial<OpeningHost> = {}): OpeningHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, spendable: () => 500_000, ships: () => SHIPS, yards: async () => [], bestRouteProfit: () => 50_000,
    surveyMissing: async () => ({ total: 1, missing: [], minGoods: 3 }), gateProgress: async () => undefined,
    startGateMission: async () => { calls.push("gate"); }, startFeed: async () => {},
    buyShip: async () => ({ symbol: "THEO-9" }), setRole: async () => {}, setContractDuty: async () => {},
    setDoctrine: async () => ({}), log: () => {}, ...over,
  };
}

describe("runner: the new steps", () => {
  it("keepers calls the host with the scope and count and the task moves on", async () => {
    const store = new MockStore([runTask({ steps: [{ kind: "keepers", scope: "top", count: 7 }] })]);
    const h = host({ addKeeperMarkets: async (scope, count) => { h.calls.push(`keepers:${scope}:${count}`); return ["X1-AA1-B1"]; } });
    await new OpeningRunnerImpl(store, h).run("t1");
    assert.deepEqual(h.calls, ["keepers:top:7"]);
    assert.equal(store.updates[0]!.updates.status, "done");
  });
  it("gateCrew assigns the bought ship; while its agent is not ready the step is retried, not failed", async () => {
    const task = runTask({ steps: [{ kind: "buyShip", shipType: "SHIP_LIGHT_HAULER", maxPrice: 1, preApproved: true }, { kind: "gateCrew", ship: { by: "step", step: 0 } }], stepIndex: 1, refs: { "0": "THEO-9" }, status: "active" });
    let ready = false;
    const store = new MockStore([task]);
    const h = host({ assignGateCarrier: async (s) => { if (!ready) throw new Error(`${s} is not a miner or trader — missions need a cargo hold`); h.calls.push(`crew:${s}`); } });
    await new OpeningRunnerImpl(store, h).run("t1");
    assert.equal(store.updates.length, 0, "retry: nothing recorded, the task stays where it is");
    ready = true;
    await new OpeningRunnerImpl(store, h).run("t1");
    assert.deepEqual(h.calls, ["crew:THEO-9"]);
    assert.equal(store.updates[0]!.updates.status, "done");
  });
  it("gateCrew with a real refusal (not a retry case) fails the task and says why", async () => {
    const store = new MockStore([runTask({ steps: [{ kind: "gateCrew", ship: { by: "symbol", symbol: "THEO-9" } }] })]);
    const h = host({ assignGateCarrier: async () => { throw new Error("THEO-9 cannot reach the gate on a full tank"); } });
    await new OpeningRunnerImpl(store, h).run("t1");
    assert.equal(store.updates[0]!.updates.status, "failed");
    assert.match(String(store.updates[0]!.updates.note), /cannot reach/);
  });
  it("startGateMission before the home gate is known is retried, any other error fails", async () => {
    const store = new MockStore([runTask({ steps: [{ kind: "startGateMission", paused: true }] })]);
    await new OpeningRunnerImpl(store, host({ startGateMission: async () => { throw new Error("no jump gate known in X1-AA1"); } })).run("t1");
    assert.equal(store.updates.length, 0);
    const store2 = new MockStore([runTask({ steps: [{ kind: "startGateMission", paused: true }] })]);
    await new OpeningRunnerImpl(store2, host({ startGateMission: async () => { throw new Error("boom"); } })).run("t1");
    assert.equal(store2.updates[0]!.updates.status, "failed");
  });
  it("a minutesSinceQueued trigger uses the task's queue time", async () => {
    const old = new Date(Date.now() - 45 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    const spec: TaskSpec["steps"] = [{ kind: "setRole", ship: { by: "command" }, role: "trader" }];
    const trigger = { kind: "minutesSinceQueued", minutes: 30 } as const;
    const s1 = new MockStore([runTask({ trigger, steps: spec, createdAt: old })]);
    const h1 = host({ bestRouteProfit: () => undefined, setRole: async (sym, role) => { h1.calls.push(`role:${sym}:${role}`); } });
    await new OpeningRunnerImpl(s1, h1).run("t1");
    assert.deepEqual(h1.calls, ["role:THEO-1:trader"]);
    const s2 = new MockStore([runTask({ trigger, steps: spec, createdAt: fresh })]);
    const h2 = host({ bestRouteProfit: () => undefined });
    await new OpeningRunnerImpl(s2, h2).run("t1");
    assert.equal(s2.updates.length, 0);
  });
});

// ---- applying a template ----
describe("Store.applyOpeningTemplate", () => {
  function fakeStore(templates: { id: number; name: string; tasks: TaskSpec[] }[], existing: string[]) {
    const added: { key: string; by: string }[] = [];
    const fake = {
      listOpeningTemplates: async () => templates,
      listOpeningTasks: async () => existing.map((key) => ({ key })),
      addOpeningTask: async (_t: string, task: TaskSpec, by: string) => { added.push({ key: task.key, by }); },
    };
    return { fake, added };
  }
  const apply = (fake: unknown, name: string, suffix: string) => (Store.prototype as unknown as { applyOpeningTemplate: (this: unknown, t: string, n: string, s: string) => Promise<string> }).applyOpeningTemplate.call(fake, "t1", name, suffix);

  it("queues every task under suffixed keys, marked as queued by the reset recovery", async () => {
    const { fake, added } = fakeStore([{ id: 1, name: "Opening: auto at reset", tasks: OPENING_V3 }], ["o3-tour"]);
    const out = await apply(fake, "Opening: auto at reset", "1108");
    assert.equal(added.length, OPENING_V3.length, "last week's finished 'o3-tour' does not hold the new one back");
    assert.ok(added.every((a) => a.key.endsWith("-1108") && a.by === "reset-recovery"));
    assert.match(out, /queued 10 of 10/);
  });
  it("a missing template is seeded from the fallback when one is given, and an existing one is never overwritten", async () => {
    const saved: string[] = [];
    let templates: { id: number; name: string; tasks: TaskSpec[] }[] = [];
    const added: string[] = [];
    const fake = {
      listOpeningTemplates: async () => templates,
      saveOpeningTemplate: async (_t: string, name: string, tasks: TaskSpec[]) => { saved.push(name); templates = [{ id: 1, name, tasks }]; },
      listOpeningTasks: async () => [],
      addOpeningTask: async (_t: string, task: TaskSpec) => { added.push(task.key); },
    };
    const applyWith = (name: string) => (Store.prototype as unknown as { applyOpeningTemplate: (this: unknown, t: string, n: string, s: string, f?: TaskSpec[]) => Promise<string> }).applyOpeningTemplate.call(fake, "t1", name, "1108", OPENING_V3);
    assert.match(await applyWith("Opening: auto at reset"), /queued 10 of 10/);
    assert.deepEqual(saved, ["Opening: auto at reset"]);
    await applyWith("Opening: auto at reset");
    assert.deepEqual(saved, ["Opening: auto at reset"], "already saved: not saved again");
  });
  it("applying twice queues nothing new, and an unknown template is reported, not thrown", async () => {
    const keys = OPENING_V3.map((t) => `${t.key}-1108`);
    const { fake, added } = fakeStore([{ id: 1, name: "X", tasks: OPENING_V3 }], keys);
    assert.match(await apply(fake, "X", "1108"), /queued 0 of 10/);
    assert.equal(added.length, 0);
    assert.match(await apply(fake, "Nope", "1108"), /no opening template named "Nope"/);
  });
});

// ---- the reset recovery applies it ----
function watcherHarness(applyOpening?: ResetWatcherPorts["applyOpening"]) {
  const calls: string[] = [];
  let tokenState: "dead" | "alive" = "dead";
  let booted = false;
  let seen: string | undefined = "2026-11-01";
  const ports: ResetWatcherPorts = {
    fetchStatus: async () => ({ resetDate: "2026-11-08" }),
    getSeenResetDate: async () => seen,
    setSeenResetDate: async (d) => { calls.push(`seen:${d}`); seen = d; },
    listTenants: async () => [{ id: "t1", agentSymbol: "THEO" }],
    probeTenant: async () => tokenState,
    isBooted: () => booted, stopWorker: () => {},
    captureRunResult: async () => true,
    wipeTenantGameData: async () => { calls.push("wipe"); },
    truncateSharedGalaxy: async () => {}, resetCrawler: () => {}, beginUniverse: () => {},
    registerAndStore: async (s) => { calls.push("register"); tokenState = "alive"; return { tenantId: "t1", agentSymbol: s }; },
    boot: async () => { calls.push("boot"); booted = true; },
    ...(applyOpening ? { applyOpening } : {}),
  };
  return { w: new ResetWatcher(ports, { accountTokenConfigured: true }), calls };
}

describe("reset recovery queues the opening", () => {
  it("after the agent is registered and booted, once per reset, before the reset is marked handled", async () => {
    const { w, calls } = watcherHarness(async (id, sym, date) => { calls.push(`opening:${id}:${sym}:${date}`); return "queued 10 of 10"; });
    await w.tick();
    assert.deepEqual(calls, ["wipe", "register", "boot", "opening:t1:THEO:2026-11-08", "seen:2026-11-08"]);
  });
  it("a failure to queue it is logged and never holds the recovery", async () => {
    const { w, calls } = watcherHarness(async () => { throw new Error("db down"); });
    await w.tick();
    assert.ok(calls.includes("seen:2026-11-08"), "recovery still completes");
    assert.equal(w.status().state, "recovered");
  });
  it("without the port nothing changes (today's behaviour)", async () => {
    const { w, calls } = watcherHarness();
    await w.tick();
    assert.deepEqual(calls, ["wipe", "register", "boot", "seen:2026-11-08"]);
  });
});
