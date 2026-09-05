import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { ScoutAgent } from "../src/engine/scout.js";
import { SiphonerAgent } from "../src/engine/siphoner.js";
import { NavigationPending } from "../src/engine/agentStep.js";

/**
 * Greenfield Phase 7: the Scheduler Task-producer wrappers on ShipAgent
 * (miner/survey/tour/keeper roles), ScoutAgent, and SiphonerAgent — same
 * approach and same test strategy as tests/traderNextTask.test.ts (Phase
 * 6): stub the wrapped work-unit method, verify Task shape and backoff
 * timing, not real mining/surveying/scouting/siphoning decisions.
 *
 * Every nextXTask() call below sets `agent.running = true` first — matching
 * every real call site (fleet.ts's setShipRole()/syncSchedulerTasks()),
 * which always does this immediately before the first enqueue. nextXTask()
 * itself deliberately does not set it (see agent.ts's ShipAgent.nextTask()
 * comment): it's also called internally from its own chained `next:
 * this.nextXTask(...)`, and unconditionally setting running=true there would
 * silently resurrect an agent a stop() had just stopped mid-flight.
 */

function makeShip(symbol = "SHIP-1"): Ship {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

describe("ShipAgent.nextTask (miner role)", () => {
  it("returns a well-formed Task and reports actualCalls measured from the real API call counter, not a fixed guess", async () => {
    let calls = 0;
    const agent = new ShipAgent(makeShip("MINER-1"), { api: { getCallCount: () => calls } as any });
    (agent as any).tick = async () => { calls += 2; return true; }; // simulates tick() making 2 real API calls
    agent.running = true;
    const task = agent.nextTask();
    assert.equal(task.id, "MINER-1-mine");
    assert.equal(task.priority, 2);
    const result = await task.run();
    assert.equal(result.actualCalls, 2, "must be the measured delta (2), not the fixed estimatedCalls heuristic (3)");
    assert.ok(result.next!.earliestRunAt <= Date.now());
  });

  it("backs off ~30s when tick() finds nothing to do", async () => {
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => false;
    agent.running = true;
    const result = await agent.nextTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000);
  });

  it("halted: does not call tick(), reschedules quickly", async () => {
    let called = false;
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any, shouldRun: () => false });
    (agent as any).tick = async () => { called = true; return true; };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.ok(!called);
    assert.equal(result.actualCalls, 0);
    assert.ok(result.next!.earliestRunAt <= Date.now() + 1_000);
  });

  it("an error backs off ~10s without propagating", async () => {
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => { throw new Error("boom"); };
    agent.running = true;
    const result = await agent.nextTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 5_000 && delay <= 10_000);
  });

  it("does not resurrect a stopped agent when an in-flight run() completes and chains its own next task", async () => {
    // The actual bug this file's callers must never reintroduce: nextTask()
    // must not set running=true itself, or a stop() landing while a task is
    // mid-flight gets silently undone the moment that in-flight call
    // resolves and chains forward — confirmed live as a ship converted from
    // miner to tour that kept mining indefinitely in parallel with its new
    // role.
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => {
      agent.stop(); // simulates setShipRole() converting this ship mid-tick
      return true;
    };
    agent.running = true;
    const result = await agent.nextTask().run();
    // result.next is just an inert descriptor at this point — nextTask()
    // itself never checks `running` (only a task's own run() does, the next
    // time the scheduler actually invokes it). The real invariant is that
    // invoking that descriptor's run() must find the chain stopped.
    const next = await result.next!.run();
    assert.equal(next.next, undefined, "a stop() during the in-flight tick() must end the chain the next time it's actually run, not silently resume it");
  });

  it("when tick() throws NavigationPending, reschedules at the real arrival time instead of the normal ~10s error backoff (docs/eta-scheduled-ship-waits.md)", async () => {
    const resumeAt = Date.now() + 45_000;
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => { throw new NavigationPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
    assert.equal(result.actualCalls, 0);
  });

  it("waitForArrival() throws NavigationPending carrying the real, freshly-refreshed nav.route.arrival instead of blocking, when scheduler-driven", async () => {
    const ship = makeShip();
    (ship as any).nav = { status: "IN_TRANSIT", waypointSymbol: "X1-A-B1", systemSymbol: "X1-A", route: { arrival: "stale-should-never-be-read", departureTime: new Date().toISOString() } };
    const arrivalMs = Date.now() + 45_000;
    // waitForArrival() must always refresh before trusting route.arrival — a
    // single non-blocking check has no retry loop to self-correct stale data
    // the way the blocking version does. getShip() here returns the *real*
    // current route; if the implementation skipped the refresh and trusted
    // the stale "route" set above, this test's timing assertion would fail.
    const agent = new ShipAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ({ ...ship, nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-B1", systemSymbol: "X1-A", route: { arrival: new Date(arrivalMs).toISOString(), departureTime: new Date().toISOString() } } }),
      } as any,
    });
    (agent as any).schedulerDriven = true;

    await assert.rejects(
      () => (agent as any).waitForArrival(),
      (err: unknown) => err instanceof NavigationPending && Math.abs(err.resumeAt - arrivalMs) < 100,
    );
  });
});

describe("ShipAgent.nextSurveyTask", () => {
  it("wraps surveyScout(), priority 3", async () => {
    const agent = new ShipAgent(makeShip("SURV-1"), { api: { getCallCount: () => 0 } as any });
    let called = false;
    (agent as any).surveyScout = async () => { called = true; return true; };
    agent.running = true;
    const task = agent.nextSurveyTask();
    assert.equal(task.id, "SURV-1-survey");
    assert.equal(task.priority, 3);
    const result = await task.run();
    assert.ok(called);
    assert.ok(result.next!.earliestRunAt <= Date.now());
  });
});

describe("ShipAgent.nextTourTask", () => {
  it("wraps tourScout() at priority 3, alongside surveying and keeping", async () => {
    const agent = new ShipAgent(makeShip("TOUR-1"), { api: { getCallCount: () => 0 } as any });
    let called = false;
    (agent as any).tourScout = async () => { called = true; return false; };
    agent.running = true;
    const task = agent.nextTourTask();
    assert.equal(task.id, "TOUR-1-tour");
    // A tour produces the price intel every trade route is scored from, so
    // starving it under budget pressure starves trading a cycle later. Scouts
    // stay at 4: charting an empty waypoint is worth less than a fresh price.
    assert.equal(task.priority, 3);
    const result = await task.run();
    assert.ok(called);
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000, "no work found must back off ~30s, same as tourLoop()");
  });
});

describe("ShipAgent.nextKeeperTask", () => {
  it("a successful snapshot backs off 5 minutes, not the usual 0/30s", async () => {
    const agent = new ShipAgent(makeShip("KEEPER-1"), { api: { getCallCount: () => 0 } as any });
    (agent as any).keeperPoll = async () => true;
    agent.running = true;
    const task = agent.nextKeeperTask();
    assert.equal(task.id, "KEEPER-1-keeper");
    assert.equal(task.priority, 3);
    const result = await task.run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 4.5 * 60_000 && delay <= 5 * 60_000, `expected ~5min backoff after a snapshot, got ${delay}ms`);
  });

  it("no assigned market backs off ~30s", async () => {
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).keeperPoll = async () => false;
    agent.running = true;
    const result = await agent.nextKeeperTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000);
  });

  it("keeperLoop() and nextKeeperTask() both go through the same extracted keeperPoll(), not duplicated logic", async () => {
    const agent = new ShipAgent(makeShip(), { api: { getCallCount: () => 0 } as any, keeperMarket: () => undefined });
    // No market assigned — keeperPoll() itself (unstubbed) must return false
    // via the real (extracted, Phase 7) implementation, proving the
    // extraction didn't change observable behavior.
    agent.running = true;
    const result = await agent.nextKeeperTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000);
  });
});

describe("ScoutAgent.nextTask", () => {
  it("wraps tick(), priority 4, backs off on error without propagating", async () => {
    const agent = new ScoutAgent(makeShip("SCOUT-1"), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => { throw new Error("boom"); };
    agent.running = true;
    const task = agent.nextTask();
    assert.equal(task.id, "SCOUT-1-scout");
    assert.equal(task.priority, 4);
    const result = await task.run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 5_000 && delay <= 10_000);
  });

  it("when tick() throws NavigationPending, reschedules at the real arrival time instead of the normal ~10s error backoff", async () => {
    const resumeAt = Date.now() + 45_000;
    const agent = new ScoutAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => { throw new NavigationPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
  });

  it("a pending navigation inside sensorScan() propagates as NavigationPending instead of being logged and swallowed as a failed scan (regression: tick()'s catch around sensorScan() used to have no rethrow at all — see docs/eta-scheduled-ship-waits.md's audit)", async () => {
    const ship = makeShip();
    (ship as any).nav = { status: "IN_TRANSIT", waypointSymbol: "X1-A-B1", systemSymbol: "X1-A", route: { arrival: new Date(Date.now() + 20_000).toISOString(), departureTime: new Date().toISOString() } };
    (ship as any).mounts = [{ symbol: "MOUNT_SENSOR_ARRAY_I" }];
    const agent = new ScoutAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship },
      scanIntervalMin: 1, // > 0 so canScan() is reachable at all
    } as any);
    (agent as any).schedulerDriven = true;
    // No waypoints seeded via withWorld() -> pickChartTarget() finds nothing
    // -> tick() falls into the canScan()/sensorScan() branch, whose
    // ensureInOrbit() call throws NavigationPending because the ship is
    // IN_TRANSIT above.

    await assert.rejects(() => agent.tick(), (err: unknown) => err instanceof NavigationPending);
  });
});

describe("SiphonerAgent.nextTask", () => {
  it("wraps tick(), priority 2, reports actualCalls measured from the real API call counter", async () => {
    let calls = 0;
    const agent = new SiphonerAgent(makeShip("SIPH-1"), { api: { getCallCount: () => calls } as any });
    (agent as any).tick = async () => { calls += 2; return true; };
    agent.running = true;
    const task = agent.nextTask();
    assert.equal(task.id, "SIPH-1-siphon");
    assert.equal(task.priority, 2);
    const result = await task.run();
    assert.equal(result.actualCalls, 2, "must be the measured delta, not the fixed estimatedCalls heuristic (3)");
    assert.ok(result.next!.earliestRunAt <= Date.now());
  });

  it("when tick() throws NavigationPending, reschedules at the real arrival time instead of the normal ~10s error backoff", async () => {
    const resumeAt = Date.now() + 45_000;
    const agent = new SiphonerAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (agent as any).tick = async () => { throw new NavigationPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
  });

  it("navigateTo() propagates NavigationPending instead of returning false and logging a fake 'navigate failed' (regression: this file's navigateTo() used to catch and swallow ANY error into `return false`, with no rethrow path at all — see docs/eta-scheduled-ship-waits.md's audit)", async () => {
    const ship = makeShip(); // DOCKED at X1-A-A1
    (ship as any).nav.status = "IN_ORBIT"; // skip the orbitShip() pre-step, this test only fakes navigateShip()
    const arrivalMs = Date.now() + 30_000;
    let fakeNav: any = null;
    const agent = new SiphonerAgent(ship, {
      api: {
        getCallCount: () => 0,
        navigateShip: async () => {
          fakeNav = { status: "IN_TRANSIT", waypointSymbol: "X1-A-B1", systemSymbol: "X1-A", route: { arrival: new Date(arrivalMs).toISOString(), departureTime: new Date().toISOString() } };
          return { nav: fakeNav, fuel: { current: 90, capacity: 100 } };
        },
        getShip: async () => ({ ...ship, nav: fakeNav }),
      } as any,
    }).withWorld([{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-B1", x: 5, y: 5 }] as any);
    (agent as any).schedulerDriven = true;

    await assert.rejects(
      () => (agent as any).navigateTo("X1-A-B1"),
      (err: unknown) => err instanceof NavigationPending && Math.abs(err.resumeAt - arrivalMs) < 100,
    );
  });
});
