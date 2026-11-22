import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FORECAST, firstHourAt, floorFor, forecastPolicyFromDoctrine, forecastWeek, gateHourOf, hullYield, marginalYield } from "../src/engine/forecast.js";

test("forecast: one point per hour, cumulative profit never falls", () => {
  const pts = forecastWeek();
  assert.equal(pts.length, 168);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i]!.cumPnl >= pts[i - 1]!.cumPnl);
});

test("forecast: no hull is bought before the hour before the first heavy", () => {
  const pts = forecastWeek({ ...DEFAULT_FORECAST, gateHour: 30, firstHeavyHour: 40, startWallet: 50_000_000 });
  for (const p of pts) if (p.hour < 39) assert.equal(p.bigHulls, 0, `hour ${p.hour}`);
  assert.ok(pts[39]!.bigHulls > 0);
});

test("forecast: the buy rule never takes the wallet under the floor", () => {
  const pts = forecastWeek();
  for (const p of pts) if (p.bigHulls > 0) assert.ok(p.wallet >= floorFor(p.bigHulls, DEFAULT_FORECAST) - 1, `hour ${p.hour}`);
});

test("forecast: calibration reproduces the 11-15 no-crash estimate (gate 34, first heavy 55: 2M/h at hour 60-70)", () => {
  const pts = forecastWeek({ ...DEFAULT_FORECAST, gateHour: 34, firstHeavyHour: 55 });
  const h = firstHourAt(pts, 2_000_000);
  assert.ok(h !== null && h >= 58 && h <= 70, `2M/h at hour ${h}`);
});

test("forecast: the goal plan (gate 40, heavy at 40) is earlier than the 11-15 pace", () => {
  const goal = firstHourAt(forecastWeek(), 2_000_000);
  const slow = firstHourAt(forecastWeek({ ...DEFAULT_FORECAST, gateHour: 34, firstHeavyHour: 55 }), 2_000_000);
  assert.ok(goal !== null && slow !== null && goal < slow, `goal ${goal}, 11-15 pace ${slow}`);
});

test("forecast: hull yield falls between crowdFrom and crowdAt and the total is flat beyond crowdAt", () => {
  const p = DEFAULT_FORECAST;
  assert.equal(hullYield(1, p), p.settledYield);
  assert.equal(Math.round((p.crowdAt + 10) * hullYield(p.crowdAt + 10, p)), Math.round(p.crowdAt * p.crowdedYield));
  assert.ok(hullYield(30, p) < p.settledYield && hullYield(30, p) > p.crowdedYield);
});

test("forecast: stops buying near the end of the week when a hull cannot pay back", () => {
  const pts = forecastWeek();
  assert.equal(pts[167]!.bigHulls, pts[160]!.bigHulls);
});

test("forecast: doctrine clause off gives no policy; on takes the gate and heavy hours", () => {
  const off = forecastPolicyFromDoctrine({ isEnabled: () => false, value: () => 0 });
  assert.equal(off, null);
  const vals: Record<string, number> = { weekForecast: 33, weekForecastHeavyHour: 36 };
  const on = forecastPolicyFromDoctrine({ isEnabled: () => true, value: (k) => vals[k] ?? 0 });
  assert.equal(on?.gateHour, 33);
  assert.equal(on?.firstHeavyHour, 36);
  const noHeavy = forecastPolicyFromDoctrine({ isEnabled: (k) => k === "weekForecast", value: (k) => vals[k] ?? 0 });
  assert.equal(noHeavy?.firstHeavyHour, 33);
});

test("forecast: the gate waits for the cash to pay for it", () => {
  const pts = forecastWeek({ ...DEFAULT_FORECAST, gateHour: 10 });
  const g = gateHourOf(pts);
  assert.ok(g !== null && g > 10, `gate at ${g}`);
  assert.match(pts[g!]!.note, /late/);
});

test("forecast: beyond crowdAt a hull adds nothing, so the fleet stops growing there", () => {
  assert.ok(marginalYield(DEFAULT_FORECAST.crowdAt + 1, DEFAULT_FORECAST) <= 1);
  const pts = forecastWeek();
  assert.ok(pts[167]!.bigHulls <= DEFAULT_FORECAST.crowdAt);
});
