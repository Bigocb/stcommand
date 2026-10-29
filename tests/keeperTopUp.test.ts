import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TOPUP_POLICY, pickTopUp, type TopUpContext, type TopUpSystem } from "../src/engine/keeperTopUp.js";

const policy = { ...DEFAULT_TOPUP_POLICY, perHour: 2 };
const ctx: TopUpContext = { nowMs: 10_000_000, keepers: 100, max: 300, keeperCallsPerMin: 40, callsPerKeeper: 0.2, pending: 0 };
const systems: TopUpSystem[] = [
  { system: "X1-AA", covered: 6, candidates: ["X1-AA-1", "X1-AA-2"] },
  { system: "X1-BB", covered: 6, candidates: ["X1-BB-1", "X1-BB-2", "X1-BB-3", "X1-BB-4", "X1-BB-5", "X1-BB-6"] },
];

test("off by default: perHour 0 picks nothing", () => {
  assert.equal(pickTopUp(systems, ctx, DEFAULT_TOPUP_POLICY).market, undefined);
});

test("picks the best market of the least-covered system", () => {
  const d = pickTopUp(systems, ctx, policy);
  assert.equal(d.market, "X1-BB-1");
  assert.equal(d.system, "X1-BB");
});

test("waits out the gap since the last top-up, then goes", () => {
  assert.equal(pickTopUp(systems, { ...ctx, lastAddMs: ctx.nowMs - 10 * 60_000 }, policy).market, undefined);
  assert.equal(pickTopUp(systems, { ...ctx, lastAddMs: ctx.nowMs - 31 * 60_000 }, policy).market, "X1-BB-1");
});

test("holds while listed markets still wait for keepers", () => {
  assert.match(pickTopUp(systems, { ...ctx, pending: 3 }, policy).reason, /still wait/);
});

test("holds at the keeper limit, and 0 means no limit", () => {
  assert.equal(pickTopUp(systems, { ...ctx, keepers: 300 }, policy).market, undefined);
  assert.equal(pickTopUp(systems, { ...ctx, keepers: 5000, max: 0 }, policy).market, "X1-BB-1");
});

test("holds when one more keeper would pass the polling ceiling", () => {
  assert.match(pickTopUp(systems, { ...ctx, keeperCallsPerMin: 59.9 }, policy).reason, /no API room/);
  assert.equal(pickTopUp(systems, { ...ctx, keeperCallsPerMin: 59.7 }, policy).market, "X1-BB-1");
});

test("nothing to add when every system is covered", () => {
  assert.match(pickTopUp([{ system: "X1-AA", covered: 6, candidates: [] }], ctx, policy).reason, /covered/);
});
