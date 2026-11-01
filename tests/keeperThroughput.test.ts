import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadRate, rotationMin } from "../src/engine/keeperThroughput.js";
import { pickTopUp, DEFAULT_TOPUP_POLICY, type TopUpSystem } from "../src/engine/keeperTopUp.js";

const sys: TopUpSystem[] = [{ system: "X1-A", covered: 2, candidates: ["X1-A-M1"] }];
const ctx = { nowMs: 10_000_000, keepers: 600, max: 700, keeperCallsPerMin: 50, callsPerKeeper: 0.1, pending: 0 };
const policy = { ...DEFAULT_TOPUP_POLICY, perHour: 8, maxKeeperCalls: 90 };

describe("ReadRate", () => {
  it("counts reads in the window per minute", () => {
    const r = new ReadRate();
    const now = 60 * 60_000;
    r.note(now - 30 * 60_000); // outside the window (reads arrive oldest first)
    for (let i = 129; i >= 0; i--) r.note(now - i * 4_000); // 130 reads spread over 8.7 minutes
    assert.equal(r.perMin(now, 10 * 60_000), 13);
  });
});

describe("rotationMin", () => {
  it("is keepers over reads a minute, and unjudged right after a boot or with no reads", () => {
    assert.equal(rotationMin(600, 15, 20 * 60_000), 40);
    assert.equal(rotationMin(600, 15, 5 * 60_000), undefined);
    assert.equal(rotationMin(600, 0, 20 * 60_000), undefined);
  });
});

describe("pickTopUp rotation guard", () => {
  it("adds when the rotation is within the limit", () => {
    const d = pickTopUp(sys, { ...ctx, rotationMin: 40 }, { ...policy, maxRotationMin: 60 });
    assert.equal(d.market, "X1-A-M1");
  });

  it("refuses when keepers already take longer than the limit to read every market", () => {
    const d = pickTopUp(sys, { ...ctx, rotationMin: 75 }, { ...policy, maxRotationMin: 60 });
    assert.equal(d.market, undefined);
    assert.match(d.reason, /rotation takes 75 min/);
  });

  it("off (0) or unknown reproduces today's behaviour", () => {
    assert.equal(pickTopUp(sys, { ...ctx, rotationMin: 500 }, { ...policy, maxRotationMin: 0 }).market, "X1-A-M1");
    assert.equal(pickTopUp(sys, ctx, { ...policy, maxRotationMin: 60 }).market, "X1-A-M1");
  });
});
