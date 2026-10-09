import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { marginWaitMs } from "../src/engine/feedBackoff.js";

describe("marginWaitMs", () => {
  it("starts at 30 seconds and doubles", () => {
    assert.deepEqual([1, 2, 3, 4].map(marginWaitMs), [30_000, 60_000, 120_000, 240_000]);
  });
  it("never waits more than 5 minutes", () => {
    assert.equal(marginWaitMs(5), 300_000);
    assert.equal(marginWaitMs(50), 300_000);
  });
  it("treats a nonsense count as the first block", () => {
    assert.equal(marginWaitMs(0), 30_000);
    assert.equal(marginWaitMs(-3), 30_000);
  });
});
