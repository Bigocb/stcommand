import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StaleWhileRevalidate } from "../src/engine/staleCache.js";
import { OPS_TOOLS } from "../src/ops/catalog.js";

/** The seam for the 20 s core pass of 2026-10-31: the caller never waits for a refresh after the first value. */
describe("StaleWhileRevalidate", () => {
  it("waits for the first value only, then returns the last value at once while it refreshes behind", async () => {
    let t = 0;
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const c = new StaleWhileRevalidate<number>(1000, async () => { n++; if (n === 2) await gate; return n; }, 0, () => t);
    assert.equal(await c.get(), 1, "first call computes");
    assert.equal(await c.get(), 1, "inside the TTL: no recompute");
    assert.equal(n, 1);
    t = 1500;
    assert.equal(await c.get(), 1, "past the TTL: the old value at once, the refresh is running");
    assert.equal(n, 2);
    assert.equal(await c.get(), 1, "a refresh in flight is not started twice and still does not block");
    assert.equal(n, 2);
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(await c.get(), 2, "the refreshed value arrives");
  });

  it("a failed refresh keeps the last good value and reports the error; a failed first compute returns the initial value", async () => {
    let t = 0;
    const errors: unknown[] = [];
    let fail = false;
    const c = new StaleWhileRevalidate<string>(10, async () => { if (fail) throw new Error("429"); return "good"; }, "initial", () => t, (e) => errors.push(e));
    assert.equal(await c.get(), "good");
    fail = true; t = 50;
    assert.equal(await c.get(), "good");
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.equal(await c.get(), "good", "still the last good value");
    const d = new StaleWhileRevalidate<string>(10, async () => { throw new Error("down"); }, "initial", () => t, () => {});
    assert.equal(await d.get(), "initial");
  });

  it("invalidate() makes the next call refresh behind the old value", async () => {
    let n = 0;
    const c = new StaleWhileRevalidate<number>(1_000_000, async () => ++n, 0, () => 0);
    await c.get();
    c.invalidate();
    assert.equal(await c.get(), 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(await c.get(), 2);
  });
});

describe("ops api_budget", () => {
  it("reports the whole process's calls a minute against the cap, and its top spenders", async () => {
    const { rateLimitMonitor } = await import("../src/core/rateLimitMonitor.js");
    rateLimitMonitor.setLimiterSource(() => ({
      windowMs: 300_000, queueDepth: 3, oldestWaitMs: 4000, calls: 450, callsPerMin: 90, avgWaitMs: 700, maxWaitMs: 9000,
      byLabel: { t1: { calls: 450, avgWaitMs: 700, maxWaitMs: 9000 } }, byPriority: {}, byKind: {},
      byCaller: { "ship <- ShipProxy.refresh": { calls: 100, avgWaitMs: 800, maxWaitMs: 9000 } },
      byRole: { "keeper market": { calls: 105, avgWaitMs: 900, maxWaitMs: 9000 }, "trader market": { calls: 63, avgWaitMs: 600, maxWaitMs: 5000 } },
    }));
    const tool = OPS_TOOLS.find((x) => x.name === "api_budget")!;
    const r: any = await tool.run({ w: {}, now: () => 0 } as any, { top: 12 });
    assert.deepEqual([r.callsPerMin, r.cap, r.shareOfCap, r.queueDepth], [90, 90, 1, 3]);
    assert.deepEqual(r.byRole.map((x: any) => [x.what, x.perMin]), [["keeper market", 21], ["trader market", 12.6]]);
  });
});
