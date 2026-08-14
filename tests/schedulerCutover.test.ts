import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { Scheduler } from "../src/engine/scheduler.js";

/**
 * The Scheduler cutover: fleet.run() drives agents via Scheduler-enqueued
 * nextTask() chains instead of the old runLoop()-family blocking loops,
 * when a Scheduler is provided. Every other test file in this repo
 * constructs FleetManager without one, proving the fallback path (which
 * this file doesn't re-test) stays exactly as it was.
 */

function makeShip(symbol = "SHIP-1"): Ship {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

function makeFakeAgent(symbol: string, nextTaskId: string) {
  return {
    symbol,
    running: false,
    getShip: () => ({ symbol, nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] } }),
    isManual: () => false,
    isSuspended: () => false,
    pinnedField: () => undefined,
    stop: () => {},
    nextTask: function (this: { running: boolean }, earliestRunAt = Date.now()) {
      this.running = true;
      return { id: nextTaskId, shipSymbol: symbol, priority: 2, estimatedCalls: 1, earliestRunAt, run: async () => ({ actualCalls: 0 }) };
    },
    nextSurveyTask: function (this: { running: boolean }, earliestRunAt = Date.now()) {
      this.running = true;
      return { id: `${nextTaskId}-survey`, shipSymbol: symbol, priority: 3, estimatedCalls: 1, earliestRunAt, run: async () => ({ actualCalls: 0 }) };
    },
    nextTourTask: function (this: { running: boolean }, earliestRunAt = Date.now()) {
      this.running = true;
      return { id: `${nextTaskId}-tour`, shipSymbol: symbol, priority: 4, estimatedCalls: 1, earliestRunAt, run: async () => ({ actualCalls: 0 }) };
    },
    nextKeeperTask: function (this: { running: boolean }, earliestRunAt = Date.now()) {
      this.running = true;
      return { id: `${nextTaskId}-keeper`, shipSymbol: symbol, priority: 3, estimatedCalls: 1, earliestRunAt, run: async () => ({ actualCalls: 0 }) };
    },
  };
}

describe("FleetManager.syncSchedulerTasks", () => {
  it("does nothing when no scheduler was provided", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", "t"));
    assert.doesNotThrow(() => (fleet as any).syncSchedulerTasks());
  });

  it("enqueues each new agent's task exactly once, using the right nextTask-family method per role", () => {
    const scheduler = new Scheduler();
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any, scheduler });
    (fleet as any).miners.set("MINER-1", makeFakeAgent("MINER-1", "mine"));
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", "trade"));
    (fleet as any).surveyors.set("SURV-1", makeFakeAgent("SURV-1", "surv"));
    (fleet as any).tours.set("TOUR-1", makeFakeAgent("TOUR-1", "tour"));
    (fleet as any).keepers.set("KEEP-1", makeFakeAgent("KEEP-1", "keep"));

    (fleet as any).syncSchedulerTasks();

    // +1 for the fleet-level rescue task syncSchedulerTasks() also enqueues
    // once (see nextRescueTask()) — not per-ship, so it doesn't grow with
    // the number of agents, just always present exactly once.
    assert.equal(scheduler.size(), 6);
    for (const [sym, agent] of [
      ["MINER-1", (fleet as any).miners.get("MINER-1")],
      ["TRADER-1", (fleet as any).traders.get("TRADER-1")],
      ["SURV-1", (fleet as any).surveyors.get("SURV-1")],
      ["TOUR-1", (fleet as any).tours.get("TOUR-1")],
      ["KEEP-1", (fleet as any).keepers.get("KEEP-1")],
    ] as const) {
      assert.equal(agent.running, true, `${sym} must be marked running once scheduled`);
    }

    // A second sync must not double-enqueue anything already scheduled —
    // including the rescue task.
    (fleet as any).syncSchedulerTasks();
    assert.equal(scheduler.size(), 6);
  });

  it("enqueues a newly-added agent (e.g. a fresh ship purchase) without re-enqueueing existing ones or the rescue task", () => {
    const scheduler = new Scheduler();
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any, scheduler });
    (fleet as any).traders.set("TRADER-1", makeFakeAgent("TRADER-1", "trade"));
    (fleet as any).syncSchedulerTasks();
    assert.equal(scheduler.size(), 2, "the trader's task plus the one-time fleet-level rescue task");

    (fleet as any).traders.set("TRADER-2", makeFakeAgent("TRADER-2", "trade2"));
    (fleet as any).syncSchedulerTasks();
    assert.equal(scheduler.size(), 3, "the new trader's task, rescue still only counted once");
  });
});

describe("FleetManager.nextRescueTask", () => {
  it("is priority 0 and enqueued exactly once by syncSchedulerTasks(), regardless of how many ships exist", () => {
    const scheduler = new Scheduler();
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any, scheduler });
    (fleet as any).syncSchedulerTasks(); // no ships at all — the rescue task still gets enqueued
    assert.equal(scheduler.size(), 1);
  });

  it("does not check halted() — it must run even while the fleet is paused", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    fleet.running = true;
    let rescueCalled = false;
    (fleet as any).rescueStranded = async () => { rescueCalled = true; };
    (fleet as any).paused = true; // the fleet is halted

    const task = (fleet as any).nextRescueTask();
    await task.run();

    assert.ok(rescueCalled, "the rescue task's own run() must not gate on fleet.paused — Scheduler.runOnce()'s pause handling is what admits it");
  });

  it("chains itself every ~2s and ends the chain once the fleet stops", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    fleet.running = true;
    (fleet as any).rescueStranded = async () => {};

    const first = (fleet as any).nextRescueTask();
    const result = await first.run();
    const delay = result.next.earliestRunAt - Date.now();
    assert.ok(delay > 1_000 && delay <= 2_000, `expected ~2s rescue polling interval, got ${delay}ms`);

    fleet.stop();
    const stoppedResult = await result.next.run();
    assert.equal(stoppedResult.next, undefined, "a stopped fleet's rescue task must end the chain, not keep polling forever");
  });
});

describe("Task chain termination on stop()", () => {
  it("a stopped TraderAgent's task ends the chain (no `next`) instead of running forever", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    const task = trader.nextTask(); // marks running = true, as syncSchedulerTasks() would
    trader.stop(); // e.g. removeShip() during a scrap, or maybeAssignKeepers() converting this ship away
    const result = await task.run();
    assert.equal(result.next, undefined, "a stopped agent's in-flight task must not chain another one");
  });
});

describe("fleet.run() with a scheduler present", () => {
  it("does not start the old runLoop()-family blocking loops", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    let runLoopCalled = false;
    trader.runLoop = async () => { runLoopCalled = true; };

    const scheduler = new Scheduler();
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any, scheduler });
    (fleet as any).traders.set("SHIP-1", trader);

    await fleet.run(1);

    assert.ok(!runLoopCalled, "runLoop() must never be invoked when a Scheduler is wired in");
    fleet.stop();
  });

  it("without a scheduler, still starts the old loop (the pre-cutover fallback path)", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    let runLoopCalled = false;
    trader.runLoop = async (maxTicks: number) => { runLoopCalled = true; };

    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).traders.set("SHIP-1", trader);

    await fleet.run(1);

    assert.ok(runLoopCalled, "without a scheduler, run() must fall back to starting runLoop() exactly as before this cutover");
  });
});

describe("maybeAssignKeepers with a scheduler present", () => {
  it("enqueues the new keeper's nextKeeperTask() directly, without starting the old keeperLoop()", async () => {
    const scheduler = new Scheduler();
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any, scheduler });
    await fleet.doctrine.set("keeperCount", { value: 5, enabled: true });

    const miner = makeFakeAgent("MINER-1", "mine");
    (fleet as any).miners.set("MINER-1", miner);
    (fleet as any).syncSchedulerTasks(); // as a real tick would, before maybeAssignKeepers runs later in the same tick
    assert.equal(scheduler.size(), 2, "the miner's own task plus the one-time fleet-level rescue task");

    let keeperLoopStarted = false;
    const OriginalShipAgent = (await import("../src/engine/agent.js")).ShipAgent;
    const originalKeeperLoop = OriginalShipAgent.prototype.keeperLoop;
    OriginalShipAgent.prototype.keeperLoop = async function (this: any, maxTicks: number) { keeperLoopStarted = true; };
    try {
      // keeperPriorityMarkets() defaults to a built-in list when no store/tenantId is set.
      await (fleet as any).maybeAssignKeepers();
    } finally {
      OriginalShipAgent.prototype.keeperLoop = originalKeeperLoop;
    }

    assert.ok(!keeperLoopStarted, "the old keeperLoop() must not start when a scheduler is present");
    assert.ok((fleet as any).keepers.has("MINER-1"), "the ship must have actually been converted");
    // Three tasks now: the rescue task, the miner's now-orphaned original
    // task (still enqueued, will self-terminate via running=false once it
    // runs), plus the new keeper's task enqueued directly by
    // maybeAssignKeepers().
    assert.equal(scheduler.size(), 3);
  });
});
