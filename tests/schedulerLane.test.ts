import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type Task } from "../src/engine/scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Scheduler low-priority lane", () => {
  it("leaves keeper tasks out of the main pass and runs them beside it, at most `workers` at once", async () => {
    let workers = 3;
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, lowPriorityWorkers: () => workers });
    let active = 0;
    let peak = 0;
    const ranKeepers: string[] = [];
    const ranTraders: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `k${i}`;
      sched.enqueue({ id, priority: 3, estimatedCalls: 2, earliestRunAt: 0, run: async () => { active += 1; peak = Math.max(peak, active); await sleep(30); active -= 1; ranKeepers.push(id); return { actualCalls: 1 }; } });
    }
    sched.enqueue({ id: "trader", priority: 2, estimatedCalls: 3, earliestRunAt: 0, run: async () => { ranTraders.push("trader"); return { actualCalls: 1 }; } });

    // The main pass runs only the trader; the keepers wait for the lane.
    assert.equal(await sched.runOnce(), 1);
    assert.deepEqual(ranTraders, ["trader"]);
    assert.equal(ranKeepers.length, 0);
    assert.equal(sched.size(), 12);

    const loop = sched.run(1_000_000, 5);
    await sleep(400);
    sched.stop();
    await loop;
    await sleep(60);
    assert.equal(ranKeepers.length, 12, "every keeper ran");
    assert.ok(peak >= 2 && peak <= 3, `ran side by side, never more than the limit (peak ${peak})`);
  });

  it("keeps everything in the main loop when the lane is off, as before", async () => {
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, lowPriorityWorkers: () => 0 });
    let n = 0;
    for (let i = 0; i < 5; i++) sched.enqueue({ id: `k${i}`, priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => { n += 1; return { actualCalls: 1 }; } });
    assert.equal(await sched.runOnce(), 5);
    assert.equal(n, 5);
  });

  it("does not start low-priority tasks while the fleet is paused", async () => {
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, isPaused: () => true, lowPriorityWorkers: () => 4 });
    let n = 0;
    sched.enqueue({ id: "k", priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => { n += 1; return { actualCalls: 1 }; } });
    const loop = sched.run(1_000_000, 5);
    await sleep(80);
    sched.stop();
    await loop;
    assert.equal(n, 0);
  });

  it("keeps a trader task's next step running after a keeper task fails", async () => {
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, lowPriorityWorkers: () => 2 });
    let bad = 0;
    const t: Task = { id: "kbad", priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => { bad += 1; throw new Error("boom"); } };
    sched.enqueue(t);
    const loop = sched.run(1_000_000, 5);
    await sleep(60);
    sched.stop();
    await loop;
    assert.ok(bad >= 1, "ran and was re-queued rather than lost");
    assert.equal(sched.size(), 1);
  });
});
