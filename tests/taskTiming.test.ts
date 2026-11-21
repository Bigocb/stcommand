import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StepTimer, noteStep, runWithStepTimer } from "../src/core/stepTiming.js";
import { TaskTimingWindow, describeTiming, summarize, taskKind } from "../src/engine/taskTiming.js";
import { Scheduler } from "../src/engine/scheduler.js";

describe("stepTiming", () => {
  it("collects steps noted inside the timer's context, awaited descendants included, and nothing outside it", async () => {
    const t = new StepTimer();
    noteStep("api.wait", 999);
    await runWithStepTimer(t, async () => {
      noteStep("api.wait", 100);
      await new Promise((r) => setTimeout(r, 1));
      await (async () => noteStep("db.query", 40))();
      noteStep("api.wait", 50);
      noteStep("bad", -5);
      noteStep("bad", Number.NaN);
    });
    noteStep("db.query", 999);
    assert.deepEqual(t.ms, { "api.wait": 150, "db.query": 40 });
    assert.deepEqual(t.counts, { "api.wait": 2, "db.query": 1 });
  });

  it("keeps two concurrent tasks' timers apart", async () => {
    const a = new StepTimer();
    const b = new StepTimer();
    await Promise.all([
      runWithStepTimer(a, async () => { await new Promise((r) => setTimeout(r, 2)); noteStep("x", 1); }),
      runWithStepTimer(b, async () => { noteStep("x", 2); await new Promise((r) => setTimeout(r, 1)); noteStep("x", 2); }),
    ]);
    assert.equal(a.ms.x, 1);
    assert.equal(b.ms.x, 4);
  });
});

describe("taskTiming", () => {
  it("names the task kind from the id", () => {
    assert.equal(taskKind("THEO-1A-keeper"), "keeper");
    assert.equal(taskKind("solo"), "solo");
  });

  it("splits held time into steps and other, with shares and counts", () => {
    const s = summarize("keeper", [
      { at: 0, kind: "keeper", totalMs: 10_000, steps: { "api.wait": 200, "db.wait": 6_000, "db.query": 2_000 }, counts: { "api.wait": 1, "db.wait": 20 } },
      { at: 1, kind: "keeper", totalMs: 20_000, steps: { "api.wait": 400, "db.wait": 14_000, "db.query": 4_000 }, counts: { "api.wait": 1, "db.wait": 20 } },
    ], 600_000);
    assert.equal(s.tasks, 2);
    assert.equal(s.avgHeldMs, 15_000);
    assert.equal(s.maxHeldMs, 20_000);
    assert.equal(s.p90HeldMs, 20_000);
    assert.deepEqual(s.avgStepMs, { "api.wait": 300, "db.query": 3_000, "db.wait": 10_000, other: 1_700 });
    assert.equal(s.sharePct["db.wait"], 66.7);
    assert.equal(s.avgStepCount["db.wait"], 20);
    const line = describeTiming(s);
    assert.match(line, /^keeper tasks 2 in 10m: held avg 15\.0s/);
    assert.ok(line.indexOf("db.wait") < line.indexOf("db.query"), "biggest step first");
  });

  it("never reports negative other when steps overlap", () => {
    const s = summarize("k", [{ at: 0, kind: "k", totalMs: 100, steps: { a: 80, b: 80 }, counts: {} }], 60_000);
    assert.equal(s.avgStepMs.other, 0);
  });

  it("forgets samples older than the window and filters by kind", () => {
    const w = new TaskTimingWindow(60_000, 100);
    w.note({ at: 0, kind: "keeper", totalMs: 1_000, steps: {}, counts: {} });
    w.note({ at: 30_000, kind: "keeper", totalMs: 3_000, steps: {}, counts: {} });
    w.note({ at: 30_000, kind: "mine", totalMs: 500, steps: {}, counts: {} });
    assert.equal(w.summary(50_000, "keeper")[0]!.tasks, 2);
    const later = w.summary(70_000);
    assert.deepEqual(later.map((s) => [s.kind, s.tasks, s.avgHeldMs]), [["keeper", 1, 3_000], ["mine", 1, 500]]);
    assert.deepEqual(w.summary(200_000), []);
  });

  it("caps the number of samples kept", () => {
    const w = new TaskTimingWindow(60_000, 3);
    for (let i = 0; i < 10; i++) w.note({ at: i, kind: "keeper", totalMs: i, steps: {}, counts: {} });
    assert.equal(w.summary(10)[0]!.tasks, 3);
  });
});

describe("Scheduler onTaskTimed", () => {
  it("reports each task's held time and the steps noted while it ran", async () => {
    const seen: { id: string; ms: number; steps: Record<string, number> }[] = [];
    const s = new Scheduler({ onTaskTimed: (task, ms, timer) => seen.push({ id: task.id, ms, steps: { ...timer.ms } }) });
    s.enqueue({
      id: "S-1-keeper", shipSymbol: "S-1", priority: 3, estimatedCalls: 1, earliestRunAt: 0,
      run: async () => { noteStep("db.wait", 7); await new Promise((r) => setTimeout(r, 5)); return { actualCalls: 1 }; },
    });
    await s.runOnce();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.id, "S-1-keeper");
    assert.deepEqual(seen[0]!.steps, { "db.wait": 7 });
    assert.ok(seen[0]!.ms >= 4);
  });

  it("without the hook, runs tasks exactly as before", async () => {
    const s = new Scheduler();
    let ran = 0;
    s.enqueue({ id: "S-1-keeper", shipSymbol: "S-1", priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => { ran += 1; return { actualCalls: 1 }; } });
    assert.equal(await s.runOnce(), 1);
    assert.equal(ran, 1);
  });

  it("a throwing hook does not fail the task", async () => {
    const s = new Scheduler({ onTaskTimed: () => { throw new Error("boom"); } });
    s.enqueue({ id: "S-1-keeper", shipSymbol: "S-1", priority: 3, estimatedCalls: 1, earliestRunAt: 0, run: async () => ({ actualCalls: 1 }) });
    assert.equal(await s.runOnce(), 1);
  });
});
