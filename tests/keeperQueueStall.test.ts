import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STALL_POLICY, inCooldown, releaseReason, shouldRelease } from "../src/engine/keeperQueueStall.js";

const on = { ...DEFAULT_STALL_POLICY, graceMin: 30 };
const MIN = 60_000;

describe("keeperQueueStall", () => {
  it("off (grace 0) never releases: the old behaviour", () => {
    assert.equal(shouldRelease(0, 100 * 60 * MIN, DEFAULT_STALL_POLICY), false);
  });
  it("releases only once the grace has passed", () => {
    assert.equal(shouldRelease(0, 29 * MIN, on), false);
    assert.equal(shouldRelease(0, 30 * MIN, on), true);
  });
  it("leaves a released market alone until its cooldown ends", () => {
    assert.equal(inCooldown(undefined, 5), false);
    assert.equal(inCooldown(1000, 999), true);
    assert.equal(inCooldown(1000, 1000), false);
  });
  it("says what happened and for how long", () => {
    const line = releaseReason("X1-CK45-D44", "X1-CK45-A2", 31.2, on);
    assert.match(line, /X1-CK45-D44/);
    assert.match(line, /after 31 min/);
    assert.match(line, /120 min/);
  });
});
