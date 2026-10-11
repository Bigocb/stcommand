import { test } from "node:test";
import assert from "node:assert/strict";
import { routeStatus, ratePerHour } from "../src/engine/routeStatus.js";
import type { DispatchExplainSnapshot } from "../src/engine/dispatchExplain.js";

const r = { good: "FOOD", buyAt: "B", sellAt: "S" };
const snap = (over: Partial<DispatchExplainSnapshot> = {}): DispatchExplainSnapshot => ({
  at: 0, floorDropped: [], traders: [],
  routes: [{ key: "FOOD", good: "FOOD", buyAt: "B", sellAt: "S", profitPerTrip: 1, score: 1 }], ...over,
});

test("names the ship flying it, marking a pinned one", () => {
  const s = routeStatus(r, [{ shipSymbol: "T-1", good: "FOOD", buyAt: "B", sellAt: "S", source: "manual" }, { shipSymbol: "T-2", good: "FOOD", buyAt: "B", sellAt: "S2" }], snap(), undefined);
  assert.deepEqual(s, { flownBy: ["T-1 (pinned)"], reason: null });
});
test("a blocked sell market is the reason", () => assert.match(routeStatus(r, [], snap(), "S is taken by T-9").reason!, /taken by T-9/));
test("before the first dispatcher cycle", () => assert.match(routeStatus(r, [], undefined, undefined).reason!, /not run yet/));
test("under the floor and missing from the list are told apart", () => {
  assert.equal(routeStatus(r, [], snap({ routes: [], floorDropped: [{ key: "FOOD", good: "FOOD", buyAt: "B", sellAt: "S", profitPerTrip: 1, score: 1 }] }), undefined).reason, "under the margin floor");
  assert.match(routeStatus(r, [], snap({ routes: [] }), undefined).reason!, /not on the dispatcher's list/);
});
test("claimed by another ship", () =>
  assert.equal(routeStatus(r, [], snap({ routes: [{ key: "FOOD", good: "FOOD", buyAt: "B", sellAt: "S", profitPerTrip: 1, score: 1, claimedBy: "T-3" }] }), undefined).reason, "held for T-3"));
test("a trader's rejection is reported, with a count for more", () => {
  const rej = (ship: string, reason: string) => ({ ship, busy: false, rejected: [{ key: "FOOD", good: "FOOD", reason }] });
  assert.equal(routeStatus(r, [], snap({ traders: [rej("T-1", "outscored by MEDICINE")] }), undefined).reason, "T-1: outscored by MEDICINE");
  assert.equal(routeStatus(r, [], snap({ traders: [rej("T-1", "a"), rej("T-2", "b")] }), undefined).reason, "T-1: a (+1 more)");
});
test("every trader busy", () =>
  assert.equal(routeStatus(r, [], snap({ traders: [{ ship: "T-1", busy: true, rejected: [] }] }), undefined).reason, "every trader already has work"));
test("rate per hour", () => {
  assert.equal(ratePerHour(600, 600), 3600);
  assert.equal(ratePerHour(600, undefined), null);
});
