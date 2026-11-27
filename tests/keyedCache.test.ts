import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keyedTtlCache } from "../src/http/cache.js";
import { EndpointStats, routeKey } from "../src/http/endpointStats.js";

describe("keyedTtlCache (issue #87)", () => {
  it("builds once per key inside the TTL and again after it", async () => {
    let t = 0, builds = 0;
    const c = keyedTtlCache<string, number>({ ttlMs: 1000, now: () => t });
    const b = async () => ++builds;
    assert.equal(await c.get("a", b), 1);
    t = 999;
    assert.equal(await c.get("a", b), 1);
    assert.equal(await c.get("b", b), 2, "another key builds its own");
    t = 1000;
    assert.equal(await c.get("a", b), 3);
  });
  it("shares one build between concurrent callers on a cold key", async () => {
    let builds = 0;
    const c = keyedTtlCache<string, number>({ ttlMs: 1000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const b = async () => { builds++; await gate; return 7; };
    const p = Promise.all([c.get("k", b), c.get("k", b), c.get("k", b)]);
    release();
    assert.deepEqual(await p, [7, 7, 7]);
    assert.equal(builds, 1);
  });
  it("does not cache a failed build", async () => {
    let n = 0;
    const c = keyedTtlCache<string, number>({ ttlMs: 1000 });
    await assert.rejects(c.get("k", async () => { n++; throw new Error("db down"); }));
    assert.equal(await c.get("k", async () => ++n), 2);
  });
  it("takes a TTL per key and drops the oldest past maxEntries", async () => {
    let t = 0;
    const c = keyedTtlCache<string, string>({ ttlMs: (k) => (k.startsWith("live") ? 10 : 1000), maxEntries: 2, now: () => t });
    await c.get("live|a", async () => "1");
    await c.get("done|a", async () => "2");
    t = 20;
    assert.equal(await c.get("live|a", async () => "3"), "3", "the live key expired");
    assert.equal(await c.get("done|a", async () => "x"), "2", "the finished week did not");
    await c.get("third", async () => "4");
    assert.equal(c.size(), 2);
  });
});

describe("EndpointStats (issue #87)", () => {
  it("sums calls, JSON size, time and cache share per route, newest window only", () => {
    const s = new EndpointStats(24 * 3600_000, 1000, 0);
    const MIN = 60_000;
    s.record({ at: 1 * MIN, route: "GET /api/bridge", jsonBytes: 2 * 1048576, sentBytes: 200_000, ms: 900, status: 200 });
    s.record({ at: 2 * MIN, route: "GET /api/bridge", jsonBytes: 2 * 1048576, sentBytes: 200_000, ms: 5, status: 200, cached: true });
    s.record({ at: 3 * MIN, route: "GET /api/state", jsonBytes: 10_240, sentBytes: 2_000, ms: 20, status: 200 });
    s.record({ at: 4 * MIN, route: "GET /api/state", jsonBytes: 10_240, sentBytes: 2_000, ms: 20, status: 500 });
    const r = s.summary(10 * MIN, 60 * MIN);
    assert.equal(r.endpoints[0]!.route, "GET /api/bridge", "sorted by JSON built");
    assert.equal(r.endpoints[0]!.calls, 2);
    assert.equal(r.endpoints[0]!.totalJsonMB, 4);
    assert.equal(r.endpoints[0]!.cachedShare, 0.5);
    assert.equal(r.endpoints[0]!.maxMs, 900);
    assert.equal(r.endpoints[1]!.errors, 1);
    assert.equal(s.summary(10 * MIN, 7 * MIN).calls, 2, "a 7-minute window holds only the last two");
  });
  it("folds symbols and ids out of the route key", () => {
    assert.equal(routeKey({ method: "GET", originalUrl: "/api/ships/THEO-1BA/log?x=1" }), "GET /api/ships/:ship/log");
    assert.equal(routeKey({ method: "GET", originalUrl: "/api/markets?system=X1-GA79" }), "GET /api/markets");
    assert.equal(routeKey({ method: "GET", originalUrl: "/api/market/X1-GA79-FZ2F" }), "GET /api/market/:sym");
  });
});
