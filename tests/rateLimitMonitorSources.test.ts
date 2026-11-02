import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimitMonitor, rateLimitHeaders } from "../src/core/rateLimitMonitor.js";

test("counts 429s by source and keeps the latest rate-limit headers per source", () => {
  let now = 1_000_000;
  const m = new RateLimitMonitor(() => now);
  m.record("THEO", { "x-ratelimit-limit-type": "account", "retry-after": "1" });
  m.record("THEO");
  m.record("crawler (no token)", { "x-ratelimit-limit-type": "ip-address" });
  const snap = m.snapshot();
  assert.equal(snap.hits60s, 3);
  assert.deepEqual(snap.bySource, { THEO: 2, "crawler (no token)": 1 });
  assert.equal(snap.last.THEO?.headers["x-ratelimit-limit-type"], "account");
  assert.equal(snap.last["crawler (no token)"]?.headers["x-ratelimit-limit-type"], "ip-address");
  now += 61_000;
  assert.equal(m.snapshot().hits60s, 0);
  assert.deepEqual(m.snapshot().bySource, {});
  assert.ok(m.snapshot().last.THEO, "the last headers outlive the 60 second window");
});

test("rateLimitHeaders keeps only the rate-limit related ones", () => {
  const h = new Headers({ "X-RateLimit-Limit": "2", "Retry-After": "1", "Content-Type": "application/json" });
  assert.deepEqual(rateLimitHeaders(h), { "x-ratelimit-limit": "2", "retry-after": "1" });
});
