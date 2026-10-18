import { test } from "node:test";
import assert from "node:assert/strict";
import { nextLotDecision, UNKNOWN_DROP } from "../src/engine/lotGuard.js";

// THEOREM-64, 2026-10-18: VIRAL_AGENTS cost 31,127c, 15% allowed -> floor about 26,458c. Lot one sold at 27,294c; the market then paid 20,428c.
const floor = 31_127.3 * 0.85;

test("the next lot is judged by the market's price now, not by the lot just sold", () => {
  const d = nextLotDecision({ floor, quote: 20_428, lastPrice: 27_294 });
  assert.equal(d.ok, false); assert.match(d.reason, /live quote/); assert.equal(d.expected, 20_428);
});

test("a healthy market lets the sale go on", () => {
  assert.equal(nextLotDecision({ floor, quote: 30_000, lastPrice: 30_400 }).ok, true);
});

test("a quote exactly at the floor is allowed, one coin under is not", () => {
  assert.equal(nextLotDecision({ floor: 1000, quote: 1000, lastPrice: 1200 }).ok, true);
  assert.equal(nextLotDecision({ floor: 1000, quote: 999, lastPrice: 1200 }).ok, false);
});

test("when the market cannot be read, the last drop is assumed to repeat (a quarter when there was none to compare)", () => {
  const repeat = nextLotDecision({ floor, quote: undefined, lastPrice: 27_294, prevPrice: 36_000 });   // fell 24% last lot: 27,294 * 0.758 = 20,693
  assert.equal(repeat.ok, false); assert.match(repeat.reason, /unreadable/);
  assert.ok(Math.abs(repeat.expected - 27_294 * (27_294 / 36_000)) < 1e-6);
  const first = nextLotDecision({ floor, quote: undefined, lastPrice: 27_294 });
  assert.equal(first.expected, 27_294 * UNKNOWN_DROP); assert.equal(first.ok, false);
  assert.equal(nextLotDecision({ floor, quote: undefined, lastPrice: 40_000 }).ok, true, "a high enough price survives the assumed drop");
});

test("a price that rose between lots is not extrapolated upward", () => {
  const d = nextLotDecision({ floor, quote: undefined, lastPrice: 30_000, prevPrice: 28_000 });
  assert.equal(d.expected, 30_000);
});
