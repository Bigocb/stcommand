import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paceFromBuckets } from "../src/engine/pace.js";

describe("paceFromBuckets", () => {
  it("scales the last hour, 3 hours and whole window to per hour", () => {
    // 15-minute buckets: 8 hours of 10k each, then the last hour 25k per bucket
    const b = [...Array(20).fill(10_000), ...Array(4).fill(25_000)];
    const p = paceFromBuckets(b, 15);
    assert.equal(p.perHour1h, 100_000);
    assert.equal(p.perHour3h, Math.round((8 * 10_000 + 4 * 25_000) / 3));
    assert.equal(p.perHourWindow, Math.round((20 * 10_000 + 4 * 25_000) / 6));
  });
  it("series is the trailing hour at each bucket end", () => {
    const p = paceFromBuckets([1, 1, 1, 1, 5], 15);
    assert.deepEqual(p.series, [4, 8]);
  });
  it("copes with a short or empty window", () => {
    assert.deepEqual(paceFromBuckets([], 15).series, []);
    assert.equal(paceFromBuckets([], 15).perHour1h, 0);
    assert.equal(paceFromBuckets([5_000, 5_000], 15).perHour1h, 20_000);
  });
});
