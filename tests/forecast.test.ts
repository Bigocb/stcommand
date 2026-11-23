import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FORECAST, firstHourAt, floorFor, forecastFrom, forecastPolicyFromDoctrine, forecastWeek, gateHourOf, hullYield, joinForecast, marginalYield } from "../src/engine/forecast.js";

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

test("forecast: anchored on a real week, the line starts from the real wallet and profit and uses the real gate hour", () => {
  const pnl = [0, 100_000, 150_000, 200_000, 300_000, 400_000, 500_000, 600_000];
  const a = forecastFrom({ hour: 7, cumPnl: 2_250_000, wallet: 1_000_000, units: 2000, gateOpenHour: 5, pnlByHour: pnl });
  assert.equal(a.points[0]!.hour, 8);
  assert.ok(a.points.every((p) => p.gateOpen), "gate open from the real hour");
  assert.ok(!a.points.some((p) => p.note.includes("gate opens")), "its materials are not paid for twice");
  assert.equal(a.baseRate, 358_333, "mean of the last six real hours");
  assert.equal(a.policy.postGateBase, 358_333);
  assert.ok(a.points[0]!.cumPnl > 2_250_000 && a.points[0]!.cumPnl <= 2_250_000 + 450_000 + 1);
  assert.ok(a.points[0]!.wallet > 1_000_000 - 400_000, "wallet continues from the real one");
});

test("forecast: anchored with the gate still closed, it cannot open in the past and the plan hour moves up", () => {
  const a = forecastFrom({ hour: 50, cumPnl: 9_000_000, wallet: 8_000_000, units: 20000, gateOpenHour: null, pnlByHour: [200_000, 210_000, 190_000, 220_000] });
  assert.equal(a.policy.gateHour, 51);
  assert.equal(a.policy.preGateRate, 205_000);
  assert.ok(a.points[0]!.hour === 51 && a.points[0]!.gateOpen, "the wallet can pay for it, so it opens at once");
  assert.ok(a.points[0]!.note.includes("gate opens"));
});

test("forecast: a gate that opened early lifts the line above the plan; a late one lowers it", () => {
  const plan = forecastWeek({ ...DEFAULT_FORECAST, gateHour: 40, firstHeavyHour: 40 });
  const real = Array.from({ length: 24 }, (_, h) => (h < 20 ? 150_000 : 700_000));
  const cum = real.reduce((s, x) => s + x, 0);
  const early = forecastFrom({ hour: 23, cumPnl: cum, wallet: 2_000_000, units: 5000, gateOpenHour: 20, pnlByHour: real });
  assert.ok(early.points[early.points.length - 1]!.cumPnl > plan[167]!.cumPnl, "an early gate and a faster rate end the week higher");
  const slowReal = Array.from({ length: 60 }, () => 150_000);
  const late = forecastFrom({ hour: 59, cumPnl: 9_000_000, wallet: 7_000_000, units: 20000, gateOpenHour: null, pnlByHour: slowReal });
  assert.ok(late.points[late.points.length - 1]!.cumPnl < plan[167]!.cumPnl, "a late gate ends the week lower");
});

test("forecast: too few real hours keeps the calibrated base rate", () => {
  const a = forecastFrom({ hour: 1, cumPnl: 100_000, wallet: 200_000, units: 100, gateOpenHour: null, pnlByHour: [50_000, 50_000] });
  assert.equal(a.baseRate, null);
  assert.equal(a.policy.preGateRate, DEFAULT_FORECAST.preGateRate);
});

test("forecast: joinForecast keeps the real hours first and recomputes the rate over the join", () => {
  const real = [{ hour: 0, gateOpen: false, cumPnl: 100, pnl: 100, rate: 0, units: 1, wallet: 5, bigHulls: 0, note: "real" }];
  const future = [{ hour: 1, gateOpen: false, cumPnl: 400, pnl: 300, rate: 0, units: 2, wallet: 6, bigHulls: 0, note: "" }];
  const j = joinForecast(real, future);
  assert.deepEqual(j.map((p) => p.hour), [0, 1]);
  assert.equal(j[1]!.rate, 200);
});

test("forecast: the plan-only line is unchanged by the anchor code (clause off reproduces it)", () => {
  const a = forecastWeek();
  const b = forecastWeek({ ...DEFAULT_FORECAST });
  assert.deepEqual(a, b);
  assert.equal(a.length, 168);
  assert.equal(a[0]!.wallet > 0, true);
});
