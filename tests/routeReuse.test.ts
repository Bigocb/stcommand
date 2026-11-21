import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROUTE_REUSE_POLICY, decideRouteReuse } from "../src/engine/routeReuse.js";

const on = { ...DEFAULT_ROUTE_REUSE_POLICY, maxAgeSec: 60 };

test("off by default: never reuses", () => {
  const d = decideRouteReuse({ nowMs: 10_000, builtAtMs: 9_000, buildMs: 15_000 }, DEFAULT_ROUTE_REUSE_POLICY);
  assert.equal(d.reuse, false);
});

test("reuses a recent list after a slow build", () => {
  const d = decideRouteReuse({ nowMs: 120_000, builtAtMs: 100_000, buildMs: 15_000 }, on);
  assert.equal(d.reuse, true);
  assert.match(d.reason, /20s old/);
});

test("rebuilds when the list is older than twice the build, or the ceiling", () => {
  assert.equal(decideRouteReuse({ nowMs: 140_000, builtAtMs: 100_000, buildMs: 15_000 }, on).reuse, false);
  assert.equal(decideRouteReuse({ nowMs: 200_000, builtAtMs: 100_000, buildMs: 90_000 }, on).reuse, false);
});

test("a cheap build, no list, or an invalidated list rebuilds", () => {
  assert.equal(decideRouteReuse({ nowMs: 10_000, builtAtMs: 9_000, buildMs: 1_000 }, on).reuse, false);
  assert.equal(decideRouteReuse({ nowMs: 10_000 }, on).reuse, false);
  assert.equal(decideRouteReuse({ nowMs: 10_000, builtAtMs: 9_000, buildMs: 15_000, invalidated: true }, on).reuse, false);
});

test("between recomputes a slow list is reused up to the ceiling; when a recompute is due the twice-the-build rule holds", () => {
  const sig = { nowMs: 150_000, builtAtMs: 100_000, buildMs: 8_000 };
  assert.equal(decideRouteReuse({ ...sig, recomputeDue: false }, on).reuse, true);
  assert.equal(decideRouteReuse({ ...sig, recomputeDue: true }, on).reuse, false);
  assert.equal(decideRouteReuse(sig, on).reuse, false, "unknown = the old rule");
  assert.equal(decideRouteReuse({ nowMs: 170_000, builtAtMs: 100_000, buildMs: 8_000, recomputeDue: false }, on).reuse, false, "never past the ceiling");
  assert.equal(decideRouteReuse({ ...sig, recomputeDue: false }, DEFAULT_ROUTE_REUSE_POLICY).reuse, false, "still off by default");
});
