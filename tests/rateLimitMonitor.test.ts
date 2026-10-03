import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimitMonitor } from "../src/core/rateLimitMonitor.js";

describe("RateLimitMonitor", () => {
  it("counts hits in a rolling 60s window and expires old ones", () => {
    let t = 1_000_000;
    const m = new RateLimitMonitor(() => t);
    assert.deepEqual(m.snapshot(), { hits60s: 0, lastAt: null });
    m.record(); t += 20_000; m.record(); t += 20_000; m.record();
    assert.equal(m.snapshot().hits60s, 3);
    t += 30_000; // first hit is now 70s old
    assert.equal(m.snapshot().hits60s, 2);
    t += 60_000;
    const s = m.snapshot();
    assert.equal(s.hits60s, 0);
    assert.ok(s.lastAt, "remembers when the last hit was even after the window empties");
  });
});
