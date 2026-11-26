import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRouteLength } from "../src/engine/routeLength.js";

test("same-system and one-gate legs are short at the default limit of 1", () => {
  assert.deepEqual(classifyRouteLength(0, 1), { hops: 0, length: "short" });
  assert.deepEqual(classifyRouteLength(1, 1), { hops: 1, length: "short" });
});

test("a leg past the limit is long", () => {
  assert.deepEqual(classifyRouteLength(2, 1), { hops: 2, length: "long" });
  assert.deepEqual(classifyRouteLength(1, 0), { hops: 1, length: "long" });
});

test("an unknown gate path has no length", () => {
  assert.deepEqual(classifyRouteLength(undefined, 1), { hops: null, length: null });
  assert.deepEqual(classifyRouteLength(null, 1), { hops: null, length: null });
  assert.deepEqual(classifyRouteLength(-1, 1), { hops: null, length: null });
});
