import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeTrip } from "../src/engine/tripSize.js";
import { slippageCredits } from "../src/engine/routeEconomics.js";

test("the full load is kept when it is the most profitable size", () => {
  assert.deepEqual(sizeTrip(480, 60, (u) => u * 10), { units: 480, profit: 4800, steps: 0 });
});

test("walks back from the full load and stops at the peak, not at the first size that pays", () => {
  // Concave, top near 227 units: 480 loses, 420 pays a little (32k), 240 pays the most (113k), 180 less again (109k).
  const profitAt = (u: number) => 1000 * u - 2.2 * u * u;
  const seen: number[] = [];
  const r = sizeTrip(480, 60, (u) => { seen.push(u); return profitAt(u); });
  assert.ok(profitAt(480) <= 0 && profitAt(420) > 0);
  assert.equal(r.units, 240);
  assert.equal(r.steps, 4);
  assert.ok(Math.abs(r.profit - 113_280) < 1);
  assert.deepEqual(seen, [480, 420, 360, 300, 240, 180]); // stopped one step past the top
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

test("with the real impact model, a freighter-size load that loses becomes the best smaller one", () => {
  // Buy 1,000 / sell 1,200, both markets trading 60 a lot: 480 units lose to our own impact.
  const profitAt = (u: number) => 200 * u - slippageCredits(u, 60, 1000) - slippageCredits(u, 60, 1200) - 300;
  assert.ok(profitAt(480) <= 0);
  const r = sizeTrip(480, 60, profitAt);
  assert.ok(r.units > 0 && r.units < 480 && r.profit > 0);
  for (let u = 60; u <= 480; u += 60) assert.ok(profitAt(u) <= r.profit, `size ${u} beats the pick`);
});
