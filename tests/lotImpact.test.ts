import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IMPACT_POLICY, bestUnits, learnImpact, measureRun, sizeForImpact, splitRuns, type Lot } from "../src/engine/lotImpact.js";
import { PRICE_IMPACT_PER_LOT, slippageCredits, tripEconomics } from "../src/engine/routeEconomics.js";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const on = { ...DEFAULT_IMPACT_POLICY, maxFactor: 3 };
// THEOREM-38, NEURAL_CHIPS, 2026-10-23: 80 units bought in 15-unit lots (the last 5), then 75 sold.
const buys = (at: number): Lot[] => [21677, 22758, 24089, 25727, 27745, 30228].map((price, i) => ({ units: i < 5 ? 15 : 5, price, at: at + i * 700 }));
const sells = (at: number): Lot[] => [31832, 29492, 26709, 23399, 19464].map((price, i) => ({ units: 15, price, at: at + i * 1_300 }));

describe("lotImpact", () => {
  it("measures the per-lot move of a run, buy and sell", () => {
    const b = measureRun("buy", buys(NOW), 15)!;
    assert.ok(b.perLot > 0.06 && b.perLot < 0.075, `buy ${b.perLot}`);
    const s = measureRun("sell", sells(NOW), 15)!;
    assert.ok(s.perLot > 0.1 && s.perLot < 0.13, `sell ${s.perLot}`);
  });

  it("says nothing about a run too short to show a slope", () => {
    assert.equal(measureRun("buy", [{ units: 15, price: 100, at: 0 }], 15), undefined);
    assert.equal(measureRun("buy", [{ units: 5, price: 100, at: 0 }, { units: 5, price: 110, at: 1 }], 15), undefined);
  });

  it("splits runs on a gap", () => {
    const runs = splitRuns([...sells(NOW), ...sells(NOW + 60 * MIN)], 2 * MIN);
    assert.equal(runs.length, 2);
  });

  it("off, it is the default whatever the data says", () => {
    const l = learnImpact("sell", sells(NOW - 5 * MIN), NOW, PRICE_IMPACT_PER_LOT, DEFAULT_IMPACT_POLICY, 15);
    assert.deepEqual(l, { perLot: PRICE_IMPACT_PER_LOT, runs: 0 });
  });

  it("learns above the default, never below it, never above the cap, and forgets old runs", () => {
    const l = learnImpact("sell", sells(NOW - 5 * MIN), NOW, PRICE_IMPACT_PER_LOT, on, 15);
    assert.ok(l.perLot > PRICE_IMPACT_PER_LOT && l.perLot <= PRICE_IMPACT_PER_LOT * 3);
    assert.match(l.reason!, /bid .* a lot/);
    const capped = learnImpact("sell", sells(NOW - 5 * MIN), NOW, 0.02, { ...on, maxFactor: 2 }, 15);
    assert.equal(capped.perLot, 0.04);
    // a market that barely moved is not charged less than the default
    const flat: Lot[] = [1, 2, 3, 4].map((i) => ({ units: 15, price: 1000 - i, at: NOW - 5 * MIN + i * 1000 }));
    assert.equal(learnImpact("sell", flat, NOW, PRICE_IMPACT_PER_LOT, on, 15).perLot, PRICE_IMPACT_PER_LOT);
    assert.equal(learnImpact("sell", sells(NOW - 9 * 60 * MIN), NOW, PRICE_IMPACT_PER_LOT, on, 15).runs, 0);
  });

  it("sizes a trip to where the spread stops paying for our own impact", () => {
    const base = { buyPrice: 21_677, sellPrice: 31_832, buyVolume: 15, sellVolume: 15 };
    const flat = bestUnits({ ...base, buyImpact: 0.045, sellImpact: 0.045 })!;
    const learned = bestUnits({ ...base, buyImpact: 0.068, sellImpact: 0.093 })!;
    assert.ok(learned < flat * 0.7, `learned ${learned} vs flat ${flat}`);
    const sized = sizeForImpact(80, { ...base, buyImpact: 0.068, sellImpact: 0.093 }, on);
    assert.equal(sized.units, learned);
    assert.match(sized.reason!, /not 80/);
    assert.equal(sizeForImpact(80, { ...base, buyImpact: 0.068, sellImpact: 0.093 }, DEFAULT_IMPACT_POLICY).units, 80);
    // never below one lot, never above what was asked
    assert.equal(sizeForImpact(80, { buyPrice: 100, sellPrice: 101, buyVolume: 15, sellVolume: 15, buyImpact: 0.09, sellImpact: 0.09 }, on).units, 15);
    assert.equal(sizeForImpact(10, { ...base, buyImpact: 0.045, sellImpact: 0.045 }, on).units, 10);
  });

  it("the size it picks is the one that earns the most under the same slippage the route model charges", () => {
    const base = { buyPrice: 21_677, sellPrice: 31_832, buyVolume: 15, sellVolume: 15, buyImpact: 0.068, sellImpact: 0.093 };
    const profit = (u: number) => tripEconomics({ ...base, units: u, distance: 1, fuelPrice: 0, fuelCapacity: 0, speed: 30 }).gross - tripEconomics({ ...base, units: u, distance: 1, fuelPrice: 0, fuelCapacity: 0, speed: 30 }).slippage;
    const best = bestUnits(base)!;
    assert.ok(profit(best) >= profit(best - 5) && profit(best) >= profit(best + 5));
  });

  it("slippage takes the measured impact, and the default when none is given", () => {
    assert.equal(slippageCredits(30, 15, 1000), slippageCredits(30, 15, 1000, PRICE_IMPACT_PER_LOT));
    assert.ok(slippageCredits(30, 15, 1000, 0.09) > slippageCredits(30, 15, 1000));
  });
});
