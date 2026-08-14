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
    const trader = new TraderAgent(makeShip("SHIP-1"), { api: {} as any });
    const task = trader.nextTask();
    assert.equal(task.id, "SHIP-1-trade");
    assert.equal(task.shipSymbol, "SHIP-1");
    assert.equal(task.priority, 2);
    assert.equal(task.estimatedCalls, 3);
    assert.ok(task.earliestRunAt <= Date.now());
  });

  it("when halted, does no work and reschedules quickly rather than calling tick()", async () => {
    let tickCalled = false;
    const trader = new TraderAgent(makeShip(), { api: {} as any, shouldRun: () => false });
    (trader as any).tick = async () => { tickCalled = true; return true; };

    const result = await trader.nextTask().run();

    assert.ok(!tickCalled, "a halted trader must not call tick() at all");
    assert.equal(result.actualCalls, 0);
    assert.ok(result.next);
    assert.ok(result.next!.earliestRunAt <= Date.now() + 1_000, "halt re-poll must be quick (HALT_POLL_MS), not the 30s idle backoff");
  });

  it("when tick() did work (made=true), chains an immediately-ready next task", async () => {
    const trader = new TraderAgent(makeShip(), { api: {} as any });
    (trader as any).tick = async () => true;

    const result = await trader.nextTask().run();

    assert.equal(result.actualCalls, 3);
    assert.ok(result.next);
    assert.ok(result.next!.earliestRunAt <= Date.now(), "productive work must chain a task ready to run again immediately");
  });

  it("when tick() found nothing to do (made=false), backs off ~30s — same as runLoop()'s idle sleep", async () => {
    const trader = new TraderAgent(makeShip(), { api: {} as any });
    (trader as any).tick = async () => false;

    const result = await trader.nextTask().run();

    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000, `expected ~30s backoff, got ${delay}ms`);
  });

  it("when tick() throws, backs off ~10s and does not propagate the error — same as runLoop()'s catch", async () => {
    const trader = new TraderAgent(makeShip(), { api: {} as any });
    (trader as any).tick = async () => { throw new Error("boom"); };

    const result = await trader.nextTask().run();

    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 5_000 && delay <= 10_000, `expected ~10s backoff, got ${delay}ms`);
  });

  it("a fuel-related error marks the ship stranded, same as runLoop()'s error handling", async () => {
    const trader = new TraderAgent(makeShip(), { api: {} as any });
    (trader as any).tick = async () => { throw new Error("insufficient fuel for this trip"); };

    assert.ok(!trader.isStranded());
    await trader.nextTask().run();
    assert.ok(trader.isStranded());
  });

  it("a non-fuel error does not mark the ship stranded", async () => {
    const trader = new TraderAgent(makeShip(), { api: {} as any });
    (trader as any).tick = async () => { throw new Error("market unavailable"); };

    await trader.nextTask().run();
    assert.ok(!trader.isStranded());
  });
});
