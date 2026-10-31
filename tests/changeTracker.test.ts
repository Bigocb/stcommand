import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChangeTracker, chunks } from "../src/engine/changeTracker.js";

describe("ChangeTracker", () => {
  it("reports what was never saved or differs from the last save, and nothing else", () => {
    const t = new ChangeTracker<{ state: string; target?: string }>();
    const first: [string, { state: string; target?: string }][] = [["A", { state: "docked", target: "X" }], ["B", { state: "idle" }]];
    assert.deepEqual(t.changed(first).map(([k]) => k), ["A", "B"]);
    t.markSaved(first);
    assert.deepEqual(t.changed(first), []);
    assert.deepEqual(t.changed([["A", { state: "docked", target: "Y" }], ["B", { state: "idle" }]]).map(([k]) => k), ["A"]);
  });

  it("does not remember a write that was never marked saved, and reset() forgets everything", () => {
    const t = new ChangeTracker<number>();
    t.changed([["A", 1]]);
    assert.equal(t.changed([["A", 1]]).length, 1, "a failed write is retried");
    t.markSaved([["A", 1]]);
    t.reset();
    assert.equal(t.changed([["A", 1]]).length, 1);
  });
});

describe("chunks", () => {
  it("splits into batches of at most the size", () => {
    assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunks([], 3), []);
  });
});
