import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type Task } from "../src/engine/scheduler.js";
import { countTaskCalls, noteTaskCall } from "../src/core/client.js";

/**
 * 2026-11-27: tasks were charged the client's whole call count during their run, so concurrent keeper reads (about 330 a minute)
 * kept the token budget at zero and trade, tour and rescue tasks starved. With countCalls a task is charged its own requests only.
 */
describe("scheduler: a task is charged its own calls, not everyone's (countTaskCalls)", () => {
  it("counts only requests made inside the task's own async context", async () => {
    let outside: Promise<void> | undefined;
    const { value, calls } = await countTaskCalls(async () => {
      noteTaskCall(); noteTaskCall();
      // Something else in the process sends requests at the same moment (the keeper read scheduler, another task).
      outside = (async () => { for (let i = 0; i < 20; i++) noteTaskCall(); })();
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    });
    await outside;
    assert.equal(value, "done");
    // The "outside" burst was started from inside, so it is the task's own: started elsewhere, it would not count.
    assert.equal(calls, 22);
    const other = await countTaskCalls(async () => { await new Promise((r) => setTimeout(r, 5)); return 1; });
    noteTaskCall();
    assert.equal(other.calls, 0, "a call made outside any task's context is charged to none");
  });

  it("with countCalls, a task that reports inflated actualCalls leaves the budget for the next one", async () => {
    const order: string[] = [];
    const mk = (id: string, priority: 0 | 1 | 2 | 3 | 4, calls: number, reported: number): Task => ({
      id, shipSymbol: id, priority, estimatedCalls: 3, earliestRunAt: 0,
      run: async () => { order.push(id); for (let i = 0; i < calls; i++) noteTaskCall(); return { actualCalls: reported }; },
    });
    const run = async (countCalls?: typeof countTaskCalls) => {
      order.length = 0;
      const s = new Scheduler({ ratePerSec: 0.0001, burst: 6, countCalls });
      s.enqueue(mk("a", 2, 1, 40));
      s.enqueue(mk("b", 2, 1, 40));
      await s.runOnce();
      return [...order];
    };
    assert.deepEqual(await run(), ["a"], "before: a's reported 40 calls (mostly other people's) drain the budget, b waits");
    assert.deepEqual(await run(countTaskCalls), ["a", "b"], "after: a is charged its one call, b runs too");
  });
});
