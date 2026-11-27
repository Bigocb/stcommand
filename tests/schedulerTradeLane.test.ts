import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type Task } from "../src/engine/scheduler.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isTrade = (t: Task) => t.id.endsWith("-trade");

/** n trade tasks that each take `ms`, recording how many ran at once. */
function tradeTasks(n: number, ms: number, track: { active: number; peak: number; done: number }): Task[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i}-trade`, shipSymbol: `T${i}`, priority: 2 as const, estimatedCalls: 3, earliestRunAt: 0,
    run: async () => { track.active += 1; track.peak = Math.max(track.peak, track.active); await sleep(ms); track.active -= 1; track.done += 1; return { actualCalls: 1 }; },
  }));
}

describe("Scheduler trade lane (issue #88)", () => {
  it("off (0 workers): trade tasks run one at a time in the main loop, as before", async () => {
    const t = { active: 0, peak: 0, done: 0 };
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, lanes: [{ name: "trade", takes: isTrade, workers: () => 0 }] });
    for (const task of tradeTasks(4, 30, t)) sched.enqueue(task);
    const loop = sched.run(1_000_000, 5);
    await sleep(250);
    sched.stop(); await loop; await sleep(40);
    assert.equal(t.done, 4);
    assert.equal(t.peak, 1);
  });

  it("on: up to `workers` trade tasks run at once, and a slow one no longer holds the others", async () => {
    const t = { active: 0, peak: 0, done: 0 };
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, lanes: [{ name: "trade", takes: isTrade, workers: () => 3 }] });
    for (const task of tradeTasks(6, 60, t)) sched.enqueue(task);
    const loop = sched.run(1_000_000, 5);
    await sleep(150);
    const doneEarly = t.done;
    await sleep(100);
    sched.stop(); await loop; await sleep(80);
    assert.equal(t.done, 6);
    assert.equal(t.peak, 3, "never more than the lane's workers");
    assert.ok(doneEarly >= 3, `ran side by side (${doneEarly} done after 150 ms; serial would be 2)`);
  });

  it("keeps rescue in the main loop and keepers in their own lane, each with its own workers", async () => {
    const ran: string[] = [];
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, lowPriorityWorkers: () => 1, lanes: [{ name: "trade", takes: isTrade, workers: () => 2 }] });
    sched.enqueue({ id: "fleet-rescue", priority: 0, estimatedCalls: 1, earliestRunAt: 0, run: async () => { ran.push("rescue"); return { actualCalls: 0 }; } });
    sched.enqueue({ id: "K1-keeper", priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => { ran.push("keeper"); return { actualCalls: 0 }; } });
    for (const task of tradeTasks(2, 10, { active: 0, peak: 0, done: 0 })) sched.enqueue({ ...task, run: async () => { ran.push("trade"); return { actualCalls: 0 }; } });
    assert.equal(await sched.runOnce(), 1, "the main pass runs only rescue");
    const load = sched.laneLoad();
    assert.deepEqual(load.map((l) => [l.lane, l.workers]), [["trade", 2], ["keeper", 1]]);
    const loop = sched.run(1_000_000, 5);
    await sleep(60);
    sched.stop(); await loop;
    assert.deepEqual([...ran].sort(), ["keeper", "rescue", "trade", "trade"]);
  });

  it("runs no lane task while the fleet is paused", async () => {
    let n = 0;
    const sched = new Scheduler({ ratePerSec: 1000, burst: 1000, isPaused: () => true, lanes: [{ name: "trade", takes: isTrade, workers: () => 4 }] });
    sched.enqueue({ id: "A-trade", priority: 2, estimatedCalls: 1, earliestRunAt: 0, run: async () => { n += 1; return { actualCalls: 0 }; } });
    const loop = sched.run(1_000_000, 5);
    await sleep(60);
    sched.stop(); await loop;
    assert.equal(n, 0);
  });
});
