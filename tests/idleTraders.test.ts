import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IDLE_ALERT_AFTER_MS, idleLongerThan, isIdleTrader, trackIdle } from "../src/engine/idleTraders.js";
import { idleDetector } from "../src/engine/notify/detectors.js";
import { needsYouCount } from "../src/engine/notify/badge.js";

const MIN = 60_000;
const base = { symbol: "THEOREM-17A", role: "trader", cargo: 0, doing: "docked", assigned: false };
const none = new Set<string>();

describe("idle traders", () => {
  it("is a trader with no route and an empty hold that nothing else has claimed", () => {
    assert.equal(isIdleTrader(base, none, none), true);
    assert.equal(isIdleTrader({ ...base, assigned: true }, none, none), false);
    assert.equal(isIdleTrader({ ...base, cargo: 5 }, none, none), false);
    assert.equal(isIdleTrader({ ...base, role: "keeper" }, none, none), false);
    assert.equal(isIdleTrader(base, new Set(["THEOREM-17A"]), none), false, "a feed or mission carrier");
    assert.equal(isIdleTrader(base, none, new Set(["THEOREM-17A"])), false, "waiting on a contract");
    for (const doing of ["stranded", "suspended", "manual hold", "parked"]) assert.equal(isIdleTrader({ ...base, doing }, none, none), false, doing);
  });

  it("keeps the first time a ship was seen idle, and forgets it the moment it has work", () => {
    const t0 = 1_000 * MIN;
    const a = trackIdle(new Map(), ["A", "B"], t0);
    const b = trackIdle(a, ["A"], t0 + 2 * MIN);
    assert.deepEqual([...b], [["A", t0]]);
    // B got a route and later went idle again: the clock starts over
    assert.equal(trackIdle(b, ["A", "B"], t0 + 9 * MIN).get("B"), t0 + 9 * MIN);
  });

  it("lists only ships idle for the threshold, longest first", () => {
    const now = 100 * MIN;
    const since = new Map([["fresh", now - 30_000], ["edge", now - IDLE_ALERT_AFTER_MS], ["old", now - 40 * MIN]]);
    assert.deepEqual(idleLongerThan(since, now).map((i) => i.symbol), ["old", "edge"]);
  });

  it("alerts once per ship, and counts toward the badge", () => {
    const snap = { now: 0, approvals: [], stranded: [], attention: [], idle: [{ symbol: "THEOREM-17A", idleMs: 7 * MIN + 5_000, waypoint: "X1-HM42-CA1C" }] };
    const [e] = idleDetector.detect(snap);
    assert.equal(e!.key, "idle:THEOREM-17A");
    assert.equal(e!.title, "THEOREM-17A has had no route for 7 min");
    assert.equal(e!.body, "Idle at X1-HM42-CA1C.");
    assert.equal(e!.severity, "warning");
    assert.equal(needsYouCount(snap), 1);
    assert.deepEqual(idleDetector.detect({ ...snap, idle: undefined }), []);
  });
});
