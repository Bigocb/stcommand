import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REMOTE_SURVEY_POLICY, pickRemoteSurveys, readIncomplete } from "../src/engine/remoteSurvey.js";

const reach = new Map([["X1-A", 1], ["X1-B", 1], ["X1-C", 2], ["X1-D", 3]]);
const ctx = (over: Partial<Parameters<typeof pickRemoteSurveys>[0]> = {}) => ({ reachable: reach, alreadyRead: new Set<string>(), retryAt: new Map<string, number>(), nowMs: 1000, ...over });

describe("pickRemoteSurveys", () => {
  it("off (perPass 0, the default) picks nothing", () => {
    assert.deepEqual(pickRemoteSurveys(ctx(), DEFAULT_REMOTE_SURVEY_POLICY), []);
  });
  it("takes the nearest unread systems first, by name within a distance", () => {
    assert.deepEqual(pickRemoteSurveys(ctx(), { perPass: 3 }), ["X1-A", "X1-B", "X1-C"]);
  });
  it("skips systems already read and ones waiting to be retried", () => {
    const out = pickRemoteSurveys(ctx({ alreadyRead: new Set(["X1-A"]), retryAt: new Map([["X1-B", 5000]]) }), { perPass: 5 });
    assert.deepEqual(out, ["X1-C", "X1-D"]);
  });
  it("tries a failed system again once its time has come", () => {
    assert.deepEqual(pickRemoteSurveys(ctx({ retryAt: new Map([["X1-A", 1000]]) }), { perPass: 1 }), ["X1-A"]);
  });
});

describe("readIncomplete", () => {
  it("calls a read that came back under half of the markets a failed read, and nothing else", () => {
    assert.equal(readIncomplete(6, 0), true, "X1-QK80 on 2026-10-31: 6 markets listed, 0 read");
    assert.equal(readIncomplete(6, 2), true);
    assert.equal(readIncomplete(6, 3), false, "half is enough");
    assert.equal(readIncomplete(6, 6), false);
    assert.equal(readIncomplete(0, 0), false, "no markets expected: nothing to compare (the caller marks such a system rejected)");
  });
});
