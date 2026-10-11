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
  assert.deepEqual(s, { flownBy: ["T-1 (pinned)"], reason: null, more: [], moreLabel: "" });
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
  const two = routeStatus(r, [], snap({ traders: [rej("T-1", "a"), rej("T-2", "b"), rej("T-3", "c")] }), undefined);
  assert.equal(two.reason, "T-1: a");
  assert.deepEqual(two.more, ["T-2: b", "T-3: c"]);
  assert.equal(two.moreLabel, "+2 more");
});
test("every trader occupied says what each is doing", () => {
  const traders = [{ ship: "T-1", busy: true, rejected: [] }, { ship: "T-2", busy: false, assigned: "DRUGS", rejected: [] }, { ship: "T-3", busy: false, assigned: "COPPER", rejected: [] }];
  const as = [
    { shipSymbol: "T-1", good: "FOOD", buyAt: "B", sellAt: "S" },
    { shipSymbol: "T-2", good: "DRUGS", buyAt: "B", sellAt: "S", source: "manual" },
    { shipSymbol: "T-3", good: "COPPER", buyAt: "B", sellAt: "S", source: "auto" },
  ];
  const st = routeStatus({ good: "X", buyAt: "B", sellAt: "S" }, as, snap({ routes: [{ key: "X", good: "X", buyAt: "B", sellAt: "S", profitPerTrip: 1, score: 1 }], traders }), undefined);
  assert.equal(st.reason, "every trader is occupied");
  assert.deepEqual(st.more, ["T-1 mid-trip with cargo (FOOD)", "T-2 pinned to DRUGS", "T-3 on COPPER"]);
  assert.equal(st.moreLabel, "ship by ship (3)");
});
test("rate per hour", () => {
  assert.equal(ratePerHour(600, 600), 3600);
  assert.equal(ratePerHour(600, undefined), null);
});
