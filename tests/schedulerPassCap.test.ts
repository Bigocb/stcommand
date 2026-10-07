import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PASS_MAX_MS, Scheduler, type Task } from "../src/engine/scheduler.js";

// Live 2026-10-07 (THEO): slow keeper tasks held one fixed-list pass open for 30+ minutes, and traders, ready again
// seconds after their own turn, waited for the whole of it.
describe("Scheduler.runOnce pass cap", () => {
  it("ends a pass once it has run past PASS_MAX_MS, leaving the rest for the next pass", async () => {
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000 });
    const clock = { t: Date.now() };
    const realNow = Date.now;
    Date.now = () => clock.t;
    try {
      const ran: string[] = [];
      const slow = (id: string): Task => ({
        id, priority: 3, estimatedCalls: 1, earliestRunAt: 0,
        run: async () => { ran.push(id); clock.t += 35_000; return { actualCalls: 1 }; },
      });
      for (const id of ["k1", "k2", "k3"]) sched.enqueue(slow(id));
      // The trader runs first, and its next step is due right after the first keeper starts.
      sched.enqueue({
        id: "trader", priority: 2, estimatedCalls: 1, earliestRunAt: 0,
        run: async () => {
          ran.push("trader");
          return { actualCalls: 1, next: { id: "trader", priority: 2, estimatedCalls: 1, earliestRunAt: clock.t + 1_000, run: async () => { ran.push("trader-2"); return { actualCalls: 1 }; } } };
        },
      });

      await sched.runOnce();
      assert.deepEqual(ran, ["trader", "k1"], `the pass stops after the first task to cross ${PASS_MAX_MS}ms`);
      await sched.runOnce();
      assert.deepEqual(ran, ["trader", "k1", "trader-2", "k2"], "the trader's next step goes ahead of the remaining keepers");
      await sched.runOnce();
      assert.deepEqual(ran, ["trader", "k1", "trader-2", "k2", "k3"], "nothing is dropped");
      assert.equal(sched.size(), 0);
    } finally {
      Date.now = realNow;
    }
  });

  it("still runs a whole fast pass in one go", async () => {
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000 });
    let n = 0;
    for (let i = 0; i < 30; i++) sched.enqueue({ id: `t${i}`, priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => { n += 1; return { actualCalls: 1 }; } });
    assert.equal(await sched.runOnce(), 30);
    assert.equal(n, 30);
  });
});
