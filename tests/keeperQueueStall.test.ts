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

import { serviceableFirst } from "../src/engine/keeperQueueStall.js";
describe("serviceableFirst", () => {
  it("puts markets in systems with a ship at a keeper yard first, keeping each group's order", () => {
    const out = serviceableFirst(["X1-PK42-A2", "X1-DQ39-C14B", "X1-CK45-D44", "X1-CK45-C41"], new Set(["X1-CK45"]));
    assert.deepEqual(out, ["X1-CK45-D44", "X1-CK45-C41", "X1-PK42-A2", "X1-DQ39-C14B"]);
  });
  it("leaves the list alone when no system is serviceable, and never drops a market", () => {
    const list = ["X1-A-1", "X1-B-2"];
    assert.deepEqual(serviceableFirst(list, new Set()), list);
  });
});
