import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * Greenfield Phase 6: TraderAgent.nextTask(), the Scheduler Task-producer
 * wrapper around the pre-existing `tick()` real trading logic already uses
 * (see trader.ts's nextTask() comment). These tests exercise exactly what
 * that wrapper changed — Task shape, halted/backoff/error timing — by
 * stubbing tick() itself, not real trading decisions: trader.ts's own
 * buy/sell/route logic is untouched by this phase and has no test coverage
 * here (straders' original trader.test.ts, 591 lines, was never ported —
 * see README's "not yet ported" note, unrelated to this phase).
 *
 * Every nextTask() call below sets `trader.running = true` first — matching
 * every real call site (fleet.ts's setShipRole()/syncSchedulerTasks()),
 * which always does this immediately before the first enqueue. nextTask()
 * itself deliberately does not set it (see trader.ts's own comment there):
 * it's also called internally from its own chained `next: this.nextTask(...)`,
 * and unconditionally setting running=true there too would silently
 * resurrect an agent a stop() had just stopped mid-flight.
 */

function makeShip(symbol = "SHIP-1"): Ship {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

describe("TraderAgent.nextTask", () => {
  it("returns a well-formed trade-priority Task", () => {
    const trader = new TraderAgent(makeShip("SHIP-1"), { api: { getCallCount: () => 0 } as any });
    trader.running = true;
    const task = trader.nextTask();
    assert.equal(task.id, "SHIP-1-trade");
    assert.equal(task.shipSymbol, "SHIP-1");
    assert.equal(task.priority, 2);
    assert.equal(task.estimatedCalls, 3);
    assert.ok(task.earliestRunAt <= Date.now());
  });

  it("when halted, does no work and reschedules quickly rather than calling tick()", async () => {
    let tickCalled = false;
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any, shouldRun: () => false });
    (trader as any).tick = async () => { tickCalled = true; return true; };
    trader.running = true;

    const result = await trader.nextTask().run();

    assert.ok(!tickCalled, "a halted trader must not call tick() at all");
    assert.equal(result.actualCalls, 0);
    assert.ok(result.next);
    assert.ok(result.next!.earliestRunAt <= Date.now() + 1_000, "halt re-poll must be quick (HALT_POLL_MS), not the 30s idle backoff");
  });

  it("when tick() did work (made=true), reports actualCalls measured from the real API call counter and chains an immediately-ready next task", async () => {
    let calls = 0;
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => calls } as any });
    (trader as any).tick = async () => { calls += 2; return true; }; // simulates tick() making 2 real API calls
    trader.running = true;

    const result = await trader.nextTask().run();

    assert.equal(result.actualCalls, 2, "must be the measured delta, not the fixed estimatedCalls heuristic (3)");
    assert.ok(result.next);
    assert.ok(result.next!.earliestRunAt <= Date.now(), "productive work must chain a task ready to run again immediately");
  });

  it("when tick() found nothing to do (made=false), backs off ~30s — same as runLoop()'s idle sleep", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (trader as any).tick = async () => false;
    trader.running = true;

    const result = await trader.nextTask().run();

    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000, `expected ~30s backoff, got ${delay}ms`);
  });

  it("when tick() throws, backs off ~10s and does not propagate the error — same as runLoop()'s catch", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (trader as any).tick = async () => { throw new Error("boom"); };
    trader.running = true;

    const result = await trader.nextTask().run();

    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 5_000 && delay <= 10_000, `expected ~10s backoff, got ${delay}ms`);
  });

  it("a fuel-related error on a genuinely low-fuel ship marks it stranded, same as runLoop()'s error handling", async () => {
    const ship = makeShip();
    ship.fuel = { current: 2, capacity: 100 } as any;
    const trader = new TraderAgent(ship, { api: { getCallCount: () => 0 } as any });
    (trader as any).tick = async () => { throw new Error("insufficient fuel for this trip"); };
    trader.running = true;

    assert.ok(!trader.isStranded());
    await trader.nextTask().run();
    assert.ok(trader.isStranded());
  });

  it("a fuel-related error on a full-tank ship does not mark it stranded — the leg is out of range, not a real stranding", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any }); // makeShip() defaults to a full 100/100 tank
    (trader as any).tick = async () => { throw new Error("requires 16 more fuel for navigation"); };
    trader.running = true;

    await trader.nextTask().run();
    assert.ok(!trader.isStranded());
  });

  it("a non-fuel error does not mark the ship stranded", async () => {
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (trader as any).tick = async () => { throw new Error("market unavailable"); };
    trader.running = true;

    await trader.nextTask().run();
    assert.ok(!trader.isStranded());
  });

  it("does not resurrect a stopped trader when an in-flight run() completes and chains its own next task", async () => {
    // The actual bug this file's callers must never reintroduce: nextTask()
    // must not set running=true itself, or a stop() landing while a task is
    // mid-flight gets silently undone the moment that in-flight call
    // resolves and chains forward — confirmed live as a ship converted from
    // miner to tour that kept mining indefinitely in parallel with its new
    // role.
    const trader = new TraderAgent(makeShip(), { api: { getCallCount: () => 0 } as any });
    (trader as any).tick = async () => {
      trader.stop(); // simulates setShipRole() converting this ship mid-tick
      return true;
    };
    trader.running = true;

    const result = await trader.nextTask().run();
    // result.next is just an inert descriptor at this point — nextTask()
    // itself never checks `running` (only a task's own run() does, the next
    // time the scheduler actually invokes it). The real invariant is that
    // invoking that descriptor's run() must find the chain stopped.
    const next = await result.next!.run();
    assert.equal(next.next, undefined, "a stop() during the in-flight tick() must end the chain the next time it's actually run, not silently resume it");
  });
});
