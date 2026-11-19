import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeMarketChanges } from "../src/engine/marketChanges.js";

describe("summarizeMarketChanges (pure)", () => {
  const h = (n: number) => Date.parse("2026-11-18T00:00:00Z") + n * 3_600_000;
  const rows = [
    { waypoint: "X1-A-M1", bucket: h(0), reads: 12, changed: 6 },
    { waypoint: "X1-A-M2", bucket: h(0), reads: 2, changed: 0 },
    { waypoint: "X1-A-M1", bucket: h(1), reads: 2, changed: 0 },
    { waypoint: "X1-A-M2", bucket: h(1), reads: 2, changed: 0 },
    { waypoint: "X1-B-M9", bucket: h(1), reads: 4, changed: 4 },
  ];

  it("counts reads, changed reads and markets changed per bucket, oldest first", () => {
    const r = summarizeMarketChanges(rows);
    assert.deepEqual(r.buckets.map((b) => [b.reads, b.changedReads, b.marketsChanged, b.changedPct]), [[14, 6, 1, 42.9], [8, 4, 1, 50]]);
    assert.equal(r.neverChanged, 1, "X1-A-M2 never changed");
    assert.equal(r.busiest[0]!.waypoint, "X1-A-M1");
  });

  it("restricted to keeper markets, others drop out", () => {
    const r = summarizeMarketChanges(rows, new Set(["X1-A-M1", "X1-A-M2"]));
    assert.equal(r.marketsSeen, 2);
    assert.deepEqual(r.buckets.map((b) => b.changedPct), [42.9, 0]);
    assert.match(r.reading, /1 bucket\(s\) had under 10% of reads showing a change/);
  });

  it("an empty window says so", () => {
    assert.equal(summarizeMarketChanges([]).reading, "no reads in the window");
  });
});
