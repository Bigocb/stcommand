import { test } from "node:test";
import assert from "node:assert/strict";
import { runsLeft, DEFAULT_RUNS_POLICY } from "../src/engine/runsLeft.js";

// 2026-10-11, THEOREM-A on FOOD K100 -> A1, 80u at tradeVolume 60: gross per run was 49.2k, 28.1k, 2.7k (about 34/unit,
// at the floor), then the margin was gone. The estimate says three runs.
test("FOOD K100 -> A1 with the day's prices: three runs, as observed", () => {
  const r = runsLeft({ buyPrice: 1418, sellPrice: 2076, units: 80, buyVolume: 60, sellVolume: 60, fuelCostPerRun: 150 });
  assert.equal(r.runs, 3);
  assert.equal(r.capped, false);
});

test("a deep, cheap-per-unit route lasts many runs but not forever (COPPER, 40u)", () => {
  const r = runsLeft({ buyPrice: 182, sellPrice: 283, units: 40, buyVolume: 60, sellVolume: 60, fuelCostPerRun: 144 });
  assert.ok(r.runs >= 4 && r.runs <= 8, `got ${r.runs}`);
});

test("no spread means no runs", () => {
  assert.equal(runsLeft({ buyPrice: 100, sellPrice: 100, units: 40, buyVolume: 60, sellVolume: 60, fuelCostPerRun: 0 }).runs, 0);
  assert.match(runsLeft({ buyPrice: 100, sellPrice: 101, units: 40, buyVolume: 60, sellVolume: 60, fuelCostPerRun: 0 }).reason, /floor/);
});

test("a huge market is capped", () => {
  const r = runsLeft({ buyPrice: 100, sellPrice: 300, units: 10, buyVolume: 5000, sellVolume: 5000, fuelCostPerRun: 0 });
  assert.equal(r.runs, DEFAULT_RUNS_POLICY.cap);
  assert.equal(r.capped, true);
});

test("a thinner market (smaller tradeVolume) erodes faster", () => {
  const base = { buyPrice: 150, sellPrice: 250, units: 40, sellVolume: 60, fuelCostPerRun: 100 };
  assert.ok(runsLeft({ ...base, buyVolume: 20 }).runs < runsLeft({ ...base, buyVolume: 60 }).runs);
});

test("the plain model (factor 1) lasts at least as long as the corrected one", () => {
  const i = { buyPrice: 1418, sellPrice: 2076, units: 80, buyVolume: 60, sellVolume: 60, fuelCostPerRun: 150 };
  assert.ok(runsLeft(i, { ...DEFAULT_RUNS_POLICY, observedFactor: 1 }).runs >= runsLeft(i).runs);
});
