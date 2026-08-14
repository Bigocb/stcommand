import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, SchedulerBudget, type Task } from "../src/engine/scheduler.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    priority: 2,
    estimatedCalls: 1,
    earliestRunAt: 0,
    shipSymbol: undefined,
    run: async () => ({ actualCalls: 1 }),
    ...overrides,
  };
}

describe("SchedulerBudget", () => {
  it("starts full and depletes as tokens are consumed", () => {
    const b = new SchedulerBudget(2, 10);
    assert.equal(b.availableTokens(), 10);
    b.consumeTokens(4);
    assert.ok(b.availableTokens() <= 6.5, "consuming 4 of 10 must leave roughly 6, not silently reset");
  });

  it("never goes negative", () => {
    const b = new SchedulerBudget(2, 10);
    b.consumeTokens(100);
    assert.equal(b.availableTokens(), 0);
  });
});

describe("Scheduler.runOnce", () => {
  it("runs a ready task within budget and reports it ran", async () => {
    const sched = new Scheduler({ ratePerSec: 100, burst: 100 });
    let ran = false;
    sched.enqueue(makeTask({ id: "t1", run: async () => { ran = true; return { actualCalls: 1 }; } }));
    const n = await sched.runOnce();
    assert.equal(n, 1);
    assert.ok(ran);
    assert.equal(sched.size(), 0, "a completed task must leave the queue");
  });

  it("does not run a task before its earliestRunAt", async () => {
    const sched = new Scheduler({ ratePerSec: 100, burst: 100 });
    let ran = false;
    sched.enqueue(makeTask({ id: "t1", earliestRunAt: Date.now() + 60_000, run: async () => { ran = true; return { actualCalls: 1 }; } }));
    await sched.runOnce();
    assert.ok(!ran);
    assert.equal(sched.size(), 1, "a not-yet-ready task must stay queued, not be dropped");
  });

  it("runs tasks in priority order, not enqueue order", async () => {
    const sched = new Scheduler({ ratePerSec: 100, burst: 100 });
    const order: string[] = [];
    sched.enqueue(makeTask({ id: "low", priority: 4, run: async () => { order.push("low"); return { actualCalls: 1 }; } }));
    sched.enqueue(makeTask({ id: "high", priority: 0, run: async () => { order.push("high"); return { actualCalls: 1 }; } }));
    sched.enqueue(makeTask({ id: "mid", priority: 2, run: async () => { order.push("mid"); return { actualCalls: 1 }; } }));
    await sched.runOnce();
    assert.deepEqual(order, ["high", "mid", "low"]);
  });

  it("stops admitting once the budget is exhausted, preserving remaining tasks", async () => {
    const sched = new Scheduler({ ratePerSec: 0, burst: 1 }); // exactly one token, no refill
    const ran: string[] = [];
    sched.enqueue(makeTask({ id: "a", priority: 1, estimatedCalls: 1, run: async () => { ran.push("a"); return { actualCalls: 1 }; } }));
    sched.enqueue(makeTask({ id: "b", priority: 2, estimatedCalls: 1, run: async () => { ran.push("b"); return { actualCalls: 1 }; } }));
    const n = await sched.runOnce();
    assert.equal(n, 1);
    assert.deepEqual(ran, ["a"], "only the higher-priority task should fit in one token's budget");
    assert.equal(sched.size(), 1, "the un-admitted task must stay queued for a later pass");
  });

  it("a higher-priority task later in the queue can still run even after a lower-priority one used the budget check first — priority ordering happens before admission, not on a first-come basis", async () => {
    const sched = new Scheduler({ ratePerSec: 0, burst: 5 });
    const ran: string[] = [];
    sched.enqueue(makeTask({ id: "low-1", priority: 4, estimatedCalls: 2, run: async () => { ran.push("low-1"); return { actualCalls: 2 }; } }));
    sched.enqueue(makeTask({ id: "high", priority: 0, estimatedCalls: 2, run: async () => { ran.push("high"); return { actualCalls: 2 }; } }));
    await sched.runOnce();
    assert.equal(ran[0], "high", "priority sort must place the rescue task first regardless of enqueue order");
  });

  it("while paused (isPaused returns true), only priority-0 tasks are admitted", async () => {
    let paused = true;
    const sched = new Scheduler({ ratePerSec: 100, burst: 100, isPaused: () => paused });
    const ran: string[] = [];
    sched.enqueue(makeTask({ id: "rescue", priority: 0, run: async () => { ran.push("rescue"); return { actualCalls: 1 }; } }));
    sched.enqueue(makeTask({ id: "trade", priority: 2, run: async () => { ran.push("trade"); return { actualCalls: 1 }; } }));
    await sched.runOnce();
    assert.deepEqual(ran, ["rescue"], "a halted fleet must still run rescue, and nothing else");
    assert.equal(sched.size(), 1, "the non-rescue task must stay queued, not be dropped, so it resumes once unpaused");

    paused = false;
    await sched.runOnce();
    assert.deepEqual(ran, ["rescue", "trade"]);
  });

  it("chains a task's `next` result into the queue for the following pass", async () => {
    const sched = new Scheduler({ ratePerSec: 100, burst: 100 });
    const ran: string[] = [];
    const second: Task = makeTask({ id: "step2", run: async () => { ran.push("step2"); return { actualCalls: 1 }; } });
    sched.enqueue(makeTask({ id: "step1", run: async () => { ran.push("step1"); return { actualCalls: 1, next: second }; } }));

    await sched.runOnce();
    assert.deepEqual(ran, ["step1"]);
    assert.equal(sched.size(), 1, "the chained task must be enqueued, not run inline within the same pass");

    await sched.runOnce();
    assert.deepEqual(ran, ["step1", "step2"]);
  });
});

describe("Scheduler.run / stop", () => {
  it("polls until stop() is called, without requiring maxTicks to be hit", async () => {
    const sched = new Scheduler({ ratePerSec: 100, burst: 100 });
    let calls = 0;
    sched.enqueue(makeTask({ id: "recurring", run: async () => { calls += 1; return { actualCalls: 1 }; } }));
    const runPromise = sched.run(1_000_000, 5);
    await new Promise((r) => setTimeout(r, 30));
    sched.stop();
    await runPromise;
    assert.ok(calls >= 1, "the loop must have executed at least the initial task before stopping");
  });
});

describe("Two Scheduler instances (cross-tenant isolation)", () => {
  it("each has its own independent budget and queue", async () => {
    const schedA = new Scheduler({ ratePerSec: 0, burst: 1 });
    const schedB = new Scheduler({ ratePerSec: 0, burst: 1 });
    const ranA: string[] = [];
    const ranB: string[] = [];
    schedA.enqueue(makeTask({ id: "a1", estimatedCalls: 1, run: async () => { ranA.push("a1"); return { actualCalls: 1 }; } }));
    schedA.enqueue(makeTask({ id: "a2", estimatedCalls: 1, run: async () => { ranA.push("a2"); return { actualCalls: 1 }; } }));
    schedB.enqueue(makeTask({ id: "b1", estimatedCalls: 1, run: async () => { ranB.push("b1"); return { actualCalls: 1 }; } }));

    await schedA.runOnce();
    await schedB.runOnce();

    assert.deepEqual(ranA, ["a1"], "tenant A's budget of 1 token must not be affected by tenant B's queue");
    assert.deepEqual(ranB, ["b1"], "tenant B must get its own full token, not share/inherit tenant A's depleted one");
  });
});
