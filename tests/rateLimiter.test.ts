import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, RateLimiter, SpaceTradersAPI } from "../src/core/client.js";
import { Scheduler } from "../src/engine/scheduler.js";

/**
 * Repro harness for the production 429 problem: a token bucket with a large
 * burst (30) allows many requests to leave the process in a tight cluster,
 * which can exceed a strict per-second API window even though the long-term
 * average is well below the limit.
 */
async function acquireTimes(limiter: RateLimiter, n: number): Promise<number[]> {
  const times: number[] = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      await limiter.acquire();
      times.push(Date.now());
    }),
  );
  return times.sort((a, b) => a - b);
}

function maxInWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0; i < times.length; i += 1) {
    const start = times[i]!;
    const end = start + windowMs;
    let count = 0;
    for (let j = i; j < times.length && times[j]! <= end; j += 1) count += 1;
    best = Math.max(best, count);
  }
  return best;
}

function spanMs(times: number[]): number {
  const first = times[0];
  const last = times[times.length - 1];
  assert.ok(first !== undefined && last !== undefined, "times array must not be empty");
  return last - first;
}

describe("RateLimiter burst behavior", () => {
  it("a large burst cap allows many requests to leave in a tiny window", async () => {
    const limiter = new RateLimiter(1.5, 30);
    const times = await acquireTimes(limiter, 30);
    const span = spanMs(times);
    const maxIn1s = maxInWindow(times, 1000);
    // The old behavior: 30 requests leave almost immediately. A strict 2 req/s
    // window would see all 30 in the first second and reject most of them.
    assert.ok(span < 50, `expected burst to fire within 50ms, took ${span}ms`);
    assert.equal(maxIn1s, 30, "all 30 requests land in the same 1-second window");
  });

  it("a tight burst cap smooths the same workload under the same rate", async () => {
    const limiter = new RateLimiter(1.5, 2);
    const times = await acquireTimes(limiter, 10);
    const span = spanMs(times);
    const maxIn1s = maxInWindow(times, 1000);
    assert.ok(span >= 5000, `expected 10 requests to take ~5s+, took ${span}ms`);
    assert.ok(maxIn1s <= 3, `expected at most ~3 requests in any 1s window, saw ${maxIn1s}`);
  });
});

describe("Production defaults use a tight burst cap", () => {
  it("Client without sharedLimiter defaults to burst = ceil(rate)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
      const client = new Client({ token: "t" });
      // Prime the bucket: the first ceil(1.5)=2 acquires should fire immediately.
      const t0 = Date.now();
      await client.request({ method: "GET", path: "/a" });
      await client.request({ method: "GET", path: "/b" });
      // The third request must wait for a token to refill.
      await client.request({ method: "GET", path: "/c" });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 500, `third request should have waited ~667ms, elapsed ${elapsed}ms`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SpaceTradersAPI built from a default Client inherits the same tight burst", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: { symbol: "TEST" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      const api = new SpaceTradersAPI(new Client({ token: "t" }), "t");
      const t0 = Date.now();
      await api.getMyAgent();
      await api.getMyAgent();
      await api.getMyAgent();
      assert.equal(calls, 3);
      assert.ok(Date.now() - t0 >= 500, "third call should have been rate-limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Scheduler with no options uses the same tight burst", async () => {
    const sched = new Scheduler();
    let ran = 0;
    // Enqueue 5 tiny priority-0 tasks; with burst=2 only the first two run
    // on the first pass, the rest are preserved for later passes.
    for (let i = 0; i < 5; i += 1) {
      sched.enqueue({
        id: `t${i}`,
        priority: 0,
        estimatedCalls: 1,
        earliestRunAt: 0,
        run: async () => {
          ran += 1;
          return { actualCalls: 1 };
        },
      });
    }
    await sched.runOnce();
    assert.equal(ran, 2, "default burst=2 should admit exactly 2 tasks in the first pass");
    assert.equal(sched.size(), 3, "remaining 3 tasks should stay queued");
  });
});
