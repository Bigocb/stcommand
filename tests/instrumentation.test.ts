import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type Task } from "../src/engine/scheduler.js";

/**
 * The failure mode this engine keeps producing is not a crash — it is silence.
 *
 * A repair loop that re-flew a healthy ship, a trader buying goods it never
 * delivered, six hulls holding routes none could fly, and a fleet that stood
 * still for forty minutes: every one was found by a human noticing the credit
 * balance or the map, hours late, because the code that stopped working said
 * nothing when it stopped.
 *
 * These tests pin the instrumentation that makes each of those loud.
 */

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  priority: 2,
  estimatedCalls: 1,
  earliestRunAt: 0,
  run: async () => ({ actualCalls: 1 }),
  ...over,
});

describe("the scheduler says why it is not running a task", () => {
  it("names a task that can never be admitted, rather than skipping it forever in silence", async () => {
    // The constructor comment has always warned that estimatedCalls must not
    // exceed burst, and nothing ever checked it at runtime. A task in this
    // state is skipped on every pass, for the life of the process, with no
    // error anywhere — which is indistinguishable from an idle fleet.
    const logs: string[] = [];
    const s = new Scheduler({ burst: 2, log: (m) => logs.push(m) });
    s.enqueue(task({ id: "too-big", estimatedCalls: 9 }));

    await s.runOnce();

    assert.ok(logs.some((l) => /can NEVER run/.test(l) && /too-big/.test(l)), logs.join("\n"));
    assert.match(logs.find((l) => /NEVER/.test(l))!, /estimatedCalls 9 exceeds burst 2/);
  });

  it("says it once, not on every pass", async () => {
    const logs: string[] = [];
    const s = new Scheduler({ burst: 2, log: (m) => logs.push(m) });
    s.enqueue(task({ id: "too-big", estimatedCalls: 9 }));
    for (let i = 0; i < 20; i += 1) await s.runOnce();
    assert.equal(logs.filter((l) => /can NEVER run/.test(l)).length, 1);
  });
});

describe("a failing task does not take the scheduler with it", () => {
  it("catches the throw, keeps running, and re-enqueues with a backoff", async () => {
    // Before this, `await task.run()` was unguarded: one throw rejected
    // runOnce(), which rejected run(), and every ship in the tenant stopped
    // for good behind a single log line.
    const logs: string[] = [];
    const s = new Scheduler({ log: (m) => logs.push(m) });
    let ranOther = false;

    s.enqueue(task({ id: "bad", run: async () => { throw new Error("boom"); } }));
    s.enqueue(task({ id: "good", run: async () => { ranOther = true; return { actualCalls: 1 }; } }));

    await assert.doesNotReject(() => s.runOnce());
    assert.ok(ranOther, "a sibling task must still run");
    assert.ok(logs.some((l) => /task bad threw — boom/.test(l)), logs.join("\n"));
    assert.equal(s.size(), 1, "the failed task is rescheduled, not dropped");
  });

  it("does not re-run the failed task immediately", async () => {
    let runs = 0;
    const s = new Scheduler({ log: () => {} });
    s.enqueue(task({ id: "bad", run: async () => { runs += 1; throw new Error("boom"); } }));
    await s.runOnce();
    await s.runOnce();
    assert.equal(runs, 1, "a backoff must keep a persistently failing task from spinning the runner");
  });
});

describe("the heartbeat proves the runner is alive, and whether it is working", () => {
  it("reports NOTHING HAS RUN when the queue is moving but no task is admitted", async () => {
    const logs: string[] = [];
    const s = new Scheduler({ burst: 2, log: (m) => logs.push(m), heartbeatMs: 0 });
    s.enqueue(task({ id: "too-big", estimatedCalls: 9 }));

    await s.runOnce();

    const beat = logs.find((l) => /queue=/.test(l));
    assert.ok(beat, logs.join("\n"));
    assert.match(beat!, /NOTHING HAS RUN/);
    assert.match(beat!, /skipped=1/);
  });

  it("reports work when work is happening", async () => {
    const logs: string[] = [];
    const s = new Scheduler({ log: (m) => logs.push(m), heartbeatMs: 0 });
    s.enqueue(task());
    await s.runOnce();

    const beat = logs.find((l) => /queue=/.test(l));
    assert.match(beat!, /ran=1/);
    assert.doesNotMatch(beat!, /NOTHING HAS RUN/);
  });
});

describe("the fleet notices when nothing is moving", () => {
  it("warns once the observed state has not changed for minutes, naming the scheduler's state", async () => {
    // The general alarm. Every per-subsystem log can be healthy while the
    // fleet is frozen — a stalled fleet and an idle one look identical from
    // any single component, and only a fingerprint of observed state across
    // all ships can tell them apart.
    const { FleetManager } = await import("../src/engine/fleet.js");
    const logs: string[] = [];
    const fleet = new FleetManager({
      api: { getCallCount: () => 0 } as never,
      log: (m: string) => logs.push(m),
    } as never);

    const frozen = [{ symbol: "S-1", waypoint: "X1-A-A1", doing: "in orbit", cargo: 5 }];
    (fleet as never as { fleetStatusSummary(): unknown }).fleetStatusSummary = () => frozen as never;

    const check = () => (fleet as never as { checkFleetLiveness(): void }).checkFleetLiveness();

    check(); // first sighting establishes the fingerprint
    assert.deepEqual(logs.filter((l) => l.startsWith("STALL")), []);

    // Four minutes later, nothing has changed.
    (fleet as never as { fingerprintSince: number }).fingerprintSince = Date.now() - 4 * 60_000;
    check();

    const stall = logs.find((l) => l.startsWith("STALL"));
    assert.ok(stall, `expected a stall warning, got: ${logs.join("\n")}`);
    assert.match(stall!, /no ship has changed position, status or cargo in 4m/);
  });

  it("stays quiet while ships are actually moving", async () => {
    const { FleetManager } = await import("../src/engine/fleet.js");
    const logs: string[] = [];
    const fleet = new FleetManager({
      api: { getCallCount: () => 0 } as never,
      log: (m: string) => logs.push(m),
    } as never);

    let n = 0;
    (fleet as never as { fleetStatusSummary(): unknown }).fleetStatusSummary = () =>
      [{ symbol: "S-1", waypoint: `X1-A-A${n++}`, doing: "in orbit", cargo: 0 }] as never;

    for (let i = 0; i < 5; i += 1) {
      (fleet as never as { fingerprintSince: number }).fingerprintSince = Date.now() - 9 * 60_000;
      (fleet as never as { checkFleetLiveness(): void }).checkFleetLiveness();
    }
    assert.deepEqual(logs.filter((l) => l.startsWith("STALL")), [], "movement must reset the clock");
  });
})

describe("scheduling reconciles against the agent, not a memory of the symbol", () => {
  // The stall this whole instrumentation pass was built to find. A ship that
  // changes role has its old agent stopped and a new one built in a different
  // role map; the symbol stays in scheduledShips and stays live, so the new
  // agent was never enqueued and never marked running — a live agent, in a
  // role map, that could never be scheduled again.
  const fakeAgent = (symbol: string) => ({
    symbol, running: false,
    nextTask: () => ({ id: `${symbol}-t`, shipSymbol: symbol, priority: 2 as const, estimatedCalls: 1, earliestRunAt: 0, run: async () => ({ actualCalls: 0 }) }),
  });

  async function fleetWithScheduler() {
    const { FleetManager } = await import("../src/engine/fleet.js");
    const { Scheduler } = await import("../src/engine/scheduler.js");
    const scheduler = new Scheduler({ log: () => {} });
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as never, scheduler } as never);
    return { fleet, scheduler };
  }

  it("enqueues the new agent when a ship changes role", async () => {
    const { fleet, scheduler } = await fleetWithScheduler();
    const miner = fakeAgent("SHIP-1");
    (fleet as never as { miners: Map<string, unknown> }).miners.set("SHIP-1", miner);

    (fleet as never as { syncSchedulerTasks(): void }).syncSchedulerTasks();
    assert.equal(miner.running, true, "precondition: the miner was scheduled");
    const afterFirst = scheduler.size();

    // Promotion: the old agent is stopped and a new one takes its place.
    miner.running = false;
    (fleet as never as { miners: Map<string, unknown> }).miners.delete("SHIP-1");
    const trader = fakeAgent("SHIP-1");
    (fleet as never as { traders: Map<string, unknown> }).traders.set("SHIP-1", trader);

    (fleet as never as { syncSchedulerTasks(): void }).syncSchedulerTasks();

    assert.equal(trader.running, true, "the promoted ship's new agent must be scheduled");
    assert.ok(scheduler.size() > afterFirst, "and its task actually enqueued");
  });

  it("re-enqueues any agent whose chain has ended, whatever ended it", async () => {
    // Self-healing rather than case-by-case: `running` is observed state and
    // being enqueued is desired state, so the reconcile covers causes not yet
    // imagined.
    const { fleet, scheduler } = await fleetWithScheduler();
    const miner = fakeAgent("SHIP-2");
    (fleet as never as { miners: Map<string, unknown> }).miners.set("SHIP-2", miner);
    (fleet as never as { syncSchedulerTasks(): void }).syncSchedulerTasks();
    const afterFirst = scheduler.size();

    miner.running = false; // chain ended for some reason
    (fleet as never as { syncSchedulerTasks(): void }).syncSchedulerTasks();

    assert.equal(miner.running, true);
    assert.ok(scheduler.size() > afterFirst);
  });

  it("does not double-enqueue an agent that is still running", async () => {
    const { fleet, scheduler } = await fleetWithScheduler();
    const miner = fakeAgent("SHIP-3");
    (fleet as never as { miners: Map<string, unknown> }).miners.set("SHIP-3", miner);
    (fleet as never as { syncSchedulerTasks(): void }).syncSchedulerTasks();
    const afterFirst = scheduler.size();

    for (let i = 0; i < 5; i += 1) (fleet as never as { syncSchedulerTasks(): void }).syncSchedulerTasks();

    assert.equal(scheduler.size(), afterFirst, "a healthy agent must not accumulate duplicate chains");
  });
});
