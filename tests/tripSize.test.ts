import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeTrip } from "../src/engine/tripSize.js";
import { slippageCredits } from "../src/engine/routeEconomics.js";

test("the full load is kept when it pays", () => {
  assert.deepEqual(sizeTrip(480, 60, (u) => u * 10), { units: 480, profit: 4800, steps: 0 });
});

test("steps down one lot at a time to the first size that pays", () => {
  const seen: number[] = [];
  const r = sizeTrip(480, 60, (u) => { seen.push(u); return 30_000 - u * 100; }); // pays below 300 units
  assert.deepEqual(seen, [480, 420, 360, 300, 240]);
  assert.deepEqual(r, { units: 240, profit: 6_000, steps: 4 });
});

test("a ceiling that is not a whole number of lots steps to the lot boundary below it", () => {
  const seen: number[] = [];
  sizeTrip(80, 60, (u) => { seen.push(u); return -1; });
  assert.deepEqual(seen, [80, 60]);
});

test("nothing pays: zero units, so the route is still rejected", () => {
  assert.equal(sizeTrip(480, 60, () => -5).units, 0);
  assert.equal(sizeTrip(0, 60, () => 1).units, 0);
});

test("with the real impact model, a freighter-size load that loses becomes a smaller one that pays", () => {
  // Buy 1,000 / sell 1,200, both markets trading 60 a lot: 480 units lose to our own impact, a smaller load pays.
  const profitAt = (u: number) => 200 * u - slippageCredits(u, 60, 1000) - slippageCredits(u, 60, 1200) - 300;
  assert.ok(profitAt(480) <= 0);
  const r = sizeTrip(480, 60, profitAt);
  assert.ok(r.units > 0 && r.units < 480 && r.profit > 0);
});
