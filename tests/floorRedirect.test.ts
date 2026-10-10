import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFloorRedirect } from "../src/engine/floorRedirect.js";

const sys = (w: string) => w.slice(0, w.lastIndexOf("-"));
const base = {
  good: "EQUIPMENT", here: "X1-MC94-EB3F", cost: 2767, maxLossPct: 15,
  prices: new Map([["X1-MC94-EB3F", 2146], ["X1-MB58-J60", 3620], ["X1-JJ27-D41", 3711], ["X1-MC94-EC1E", 2500]]),
  tried: new Set<string>(), systemOf: sys, reachable: () => true,
};

test("picks the best reachable market above the floor", () => {
  assert.equal(pickFloorRedirect(base)?.waypoint, "X1-JJ27-D41");
});
test("skips unreachable systems and tried markets", () => {
  const r = pickFloorRedirect({ ...base, reachable: (s) => s !== "X1-JJ27", tried: new Set(["X1-JX83-E50"]) });
  assert.equal(r?.waypoint, "X1-MB58-J60");
});
test("returns nothing when no market clears the floor", () => {
  assert.equal(pickFloorRedirect({ ...base, prices: new Map([["X1-MC94-EB3F", 2146], ["X1-MC94-EC1E", 2500]]) }), undefined);
});
