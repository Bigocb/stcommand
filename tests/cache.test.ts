import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTTLCache } from "../src/http/cache.js";

describe("makeTTLCache", () => {
  it("only calls the fetcher once within the TTL window, across repeated calls", async () => {
    let calls = 0;
    const cached = makeTTLCache(60_000, async () => { calls += 1; return "value"; });

    const a = await cached(undefined);
    const b = await cached(undefined);
    const c = await cached(undefined);

    assert.equal(calls, 1);
    assert.equal(a, "value");
    assert.equal(b, "value");
    assert.equal(c, "value");
  });

  it("re-fetches once the TTL has elapsed", async () => {
    let calls = 0;
    const cached = makeTTLCache(1, async () => { calls += 1; return calls; });

    const first = await cached(undefined);
    await new Promise((r) => setTimeout(r, 10));
    const second = await cached(undefined);

    assert.equal(first, 1);
    assert.equal(second, 2, "a call after the TTL elapsed must re-fetch, not return the stale value");
  });

  it("collapses concurrent callers on a cold cache into one real fetch", async () => {
    let calls = 0;
    const cached = makeTTLCache(60_000, async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "value";
    });

    const [a, b, c] = await Promise.all([cached(undefined), cached(undefined), cached(undefined)]);

    assert.equal(calls, 1, "three callers racing on a cold cache must share one in-flight fetch, not each trigger their own");
    assert.deepEqual([a, b, c], ["value", "value", "value"]);
  });

  it("passes the caller's argument through to the fetcher", async () => {
    const cached = makeTTLCache(60_000, async (n: number) => n * 2);
    assert.equal(await cached(21), 42);
  });
});
