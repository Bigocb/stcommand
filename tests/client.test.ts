import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Client, SpaceTradersAPI } from "../src/core/client.js";

/**
 * Client.getCallCount()/SpaceTradersAPI.getCallCount() — the real measured
 * counter Scheduler Task producers now report `actualCalls` from (see
 * trader.ts/agent.ts/scout.ts/siphoner.ts's nextTask() comments), replacing
 * what used to be a fixed heuristic.
 */
function mockFetch(handler: (url: string) => { status: number; body: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe("Client.getCallCount", () => {
  it("starts at zero and increments once per real request", async () => {
    const restore = mockFetch(() => ({ status: 200, body: { data: { symbol: "TEST" } } }));
    try {
      const client = new Client({ token: "t" });
      assert.equal(client.getCallCount(), 0);
      await client.get("/my/agent");
      assert.equal(client.getCallCount(), 1);
      await client.get("/my/agent");
      await client.get("/my/agent");
      assert.equal(client.getCallCount(), 3);
    } finally {
      restore();
    }
  });

  it("counts a retried request once per actual attempt, not once per logical call", async () => {
    let attempts = 0;
    const restore = mockFetch(() => {
      attempts += 1;
      if (attempts < 3) return { status: 500, body: { error: { message: "server error" } } };
      return { status: 200, body: { data: { symbol: "TEST" } } };
    });
    try {
      const client = new Client({ token: "t", retryBackoffMs: 1 });
      await client.get("/my/agent");
      assert.equal(client.getCallCount(), 3, "two failed attempts plus the one that succeeded — each was a real HTTP call against the rate limit");
    } finally {
      restore();
    }
  });

  it("SpaceTradersAPI.getCallCount() passes through to its own Client", async () => {
    const restore = mockFetch(() => ({ status: 200, body: { data: { symbol: "TEST" } } }));
    try {
      const client = new Client({ token: "t" });
      const api = new SpaceTradersAPI(client, "t");
      assert.equal(api.getCallCount(), 0);
      await api.getMyAgent();
      assert.equal(api.getCallCount(), 1);
      assert.equal(api.getCallCount(), client.getCallCount(), "must read the same counter, not a separate one");
    } finally {
      restore();
    }
  });
});
