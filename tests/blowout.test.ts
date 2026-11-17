import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { stepWidth, SIZE_STEPS, CHART_SELECTOR } from "../public/shared/blowout.js";

test("size steps widen the chart from the screen width up to the largest step, and stay in range", () => {
  assert.equal(stepWidth(0), "100%");
  assert.equal(stepWidth(1), "160%");
  assert.equal(stepWidth(SIZE_STEPS.length - 1), "340%");
  assert.equal(stepWidth(-3), "100%");
  assert.equal(stepWidth(99), "340%");
});

test("the selector covers the charts the apps draw and not the small icons", () => {
  assert.match(CHART_SELECTOR, /svg\[role="img"\]/);
  assert.match(CHART_SELECTOR, /pace-spark/);
  assert.match(CHART_SELECTOR, /price-chart-room svg/);
  assert.doesNotMatch(CHART_SELECTOR, /\.ti\b/);
});
