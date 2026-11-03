import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REMOTE_SURVEY_POLICY, pickRemoteSurveys, readIncomplete, withClosedGateNeighbours } from "../src/engine/remoteSurvey.js";

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

describe("withClosedGateNeighbours", () => {
  it("adds the systems directly across a closed home gate at one hop, so the surveyor reads them before the gate opens", () => {
    const out = withClosedGateNeighbours(new Map(), ["X1-DJ62", "X1-AB82"], true);
    assert.deepEqual([...out.entries()], [["X1-DJ62", 1], ["X1-AB82", 1]]);
    assert.deepEqual(pickRemoteSurveys({ reachable: out, alreadyRead: new Set(), retryAt: new Map(), nowMs: 1 }, { perPass: 3 }), ["X1-AB82", "X1-DJ62"]);
  });
  it("changes nothing once the gate is open, or when no neighbour is known", () => {
    assert.deepEqual([...withClosedGateNeighbours(reach, ["X1-Z"], false).entries()], [...reach.entries()]);
    assert.deepEqual([...withClosedGateNeighbours(new Map(), [], true).entries()], []);
  });
  it("keeps the hops of a system the walk already reached and does not touch the input", () => {
    const input = new Map([["X1-A", 2]]);
    const out = withClosedGateNeighbours(input, ["X1-A", "X1-B"], true);
    assert.equal(out.get("X1-A"), 2);
    assert.equal(out.get("X1-B"), 1);
    assert.equal(input.size, 1);
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
