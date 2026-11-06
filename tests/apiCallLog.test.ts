import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiCallLog, apiCallLog, type ApiCallEvent } from "../src/core/apiCallLog.js";
import { Client, apiRateFromEnv, DEFAULT_API_RATE, runWithApiRole } from "../src/core/client.js";

const M = 60_000;
const T0 = Date.parse("2026-11-06T03:00:00Z");
const ev = (over: Partial<ApiCallEvent> = {}): ApiCallEvent => ({ at: T0, role: "keeper", kind: "market", priority: 3, waitMs: 1000, durationMs: 200, status: 200, ...over });

describe("ApiCallLog (pure)", () => {
  it("groups calls as <role>:<call type> with rate, share, waits, answer times, 429s and errors", () => {
    const log = new ApiCallLog();
    for (let i = 0; i < 6; i++) log.record(ev({ at: T0 + i * 30_000, waitMs: 2000 + i * 1000 }));
    log.record(ev({ role: "trader", kind: "navigate", priority: 1, waitMs: 400, durationMs: 300 }));
    log.record(ev({ role: "trader", kind: "navigate", priority: 1, status: 429, waitMs: 100 }));
    log.record(ev({ role: "trader", kind: "navigate", priority: 1, status: 0 }));
    log.record(ev({ role: "trader", kind: "navigate", priority: 1, status: 502 }));
    const s = log.summary(T0 + 5 * M, 5);
    assert.equal(s.calls, 10);
    assert.deepEqual(s.rows.map((r) => r.key), ["keeper:market", "trader:navigate"]);
    const k = s.rows[0]!;
    assert.deepEqual({ calls: k.calls, perMin: k.perMin, avgWaitMs: k.avgWaitMs, maxWaitMs: k.maxWaitMs, avgAnswerMs: k.avgAnswerMs, share: k.share }, { calls: 6, perMin: 1.2, avgWaitMs: 4500, maxWaitMs: 7000, avgAnswerMs: 200, share: 0.6 });
    const t = s.rows[1]!;
    assert.deepEqual({ calls: t.calls, r429: t.r429, errors: t.errors }, { calls: 4, r429: 1, errors: 2 });
    assert.equal(s.r429, 1);
    assert.equal(s.errors, 2);
  });

  it("filters by role and by call type, and drops buckets older than the window", () => {
    const log = new ApiCallLog();
    log.record(ev({ at: T0 }));
    log.record(ev({ at: T0 + 50 * M }));
    log.record(ev({ at: T0 + 50 * M, role: "tour", kind: "dock" }));
    const now = T0 + 55 * M;
    assert.equal(log.summary(now, 60).calls, 3);
    assert.equal(log.summary(now, 20).calls, 2);
    assert.deepEqual(log.summary(now, 60, { role: "tour" }).rows.map((r) => r.key), ["tour:dock"]);
    assert.deepEqual(log.summary(now, 60, { kind: "market" }).rows.map((r) => r.key), ["keeper:market"]);
  });

  it("says how much of the window it covers, since it starts empty after a restart", () => {
    const log = new ApiCallLog();
    log.record(ev({ at: T0 }));
    assert.equal(log.summary(T0 + 20 * M, 60).coveredMin, 20);
    assert.equal(new ApiCallLog().summary(T0, 60).coveredMin, 0);
  });

  it("gives a role or call type over time in steps of 15 minutes", () => {
    const log = new ApiCallLog();
    for (let i = 0; i < 30; i++) log.record(ev({ at: T0 + i * M }));
    log.record(ev({ at: T0 + 20 * M, status: 429 }));
    const s = log.series(T0 + 30 * M, 60, { role: "keeper" }, 15);
    assert.deepEqual(s.map((x) => x.calls), [15, 16]);
    assert.equal(s[1]!.r429, 1);
    assert.equal(s[0]!.perMin, 1);
  });

  it("keeps a bounded day of buckets per key", () => {
    const log = new ApiCallLog();
    for (let i = 0; i < 400; i++) log.record(ev({ at: T0 + i * 5 * M }));
    const s = log.series(T0 + 400 * 5 * M, 100000, { role: "keeper" }, 5);
    assert.equal(s.length, 288);
  });
});

describe("API_RATE", () => {
  it("defaults to 1.75, reads the env, clamps to 0.5-1.95 and ignores junk", () => {
    assert.equal(DEFAULT_API_RATE, 1.75);
    assert.equal(apiRateFromEnv(undefined), 1.75);
    assert.equal(apiRateFromEnv(""), 1.75);
    assert.equal(apiRateFromEnv("abc"), 1.75);
    assert.equal(apiRateFromEnv("1.5"), 1.5);
    assert.equal(apiRateFromEnv("2.5"), 1.95);
    assert.equal(apiRateFromEnv("0.1"), 0.5);
  });
});

describe("Client writes every request it sends to the call log", () => {
  beforeEach(() => apiCallLog.clear());
  it("records role:call type with the answer status, and each attempt after a 429 as its own request", async () => {
    const original = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      const status = n === 1 ? 429 : 200;
      return new Response(JSON.stringify({ data: {} }), { status, headers: { "Content-Type": "application/json", "retry-after": "0" } });
    }) as typeof fetch;
    try {
      const client = new Client({ token: "t", retryBackoffMs: 1 });
      await runWithApiRole("keeper", () => client.get("/systems/X1-AB/waypoints/X1-AB-C1/market"));
      const s = apiCallLog.summary(Date.now(), 5);
      const row = s.rows.find((r) => r.key === "keeper:market")!;
      assert.equal(row.calls, 2);
      assert.equal(row.r429, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("tags an untagged call with ?", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      await new Client({ token: "t" }).get("/my/agent");
      assert.deepEqual(apiCallLog.summary(Date.now(), 5).rows.map((r) => r.key), ["?:agent"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
