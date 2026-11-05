import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { thinMarket, DEFAULT_THIN_POLICY } from "../src/engine/thinMarket.js";
import { sizeForImpact, DEFAULT_IMPACT_POLICY } from "../src/engine/lotImpact.js";

const on = { ...DEFAULT_THIN_POLICY, enabled: true };

describe("thinMarket", () => {
  it("flags a dear good in a market that takes few units a trade", () => {
    const v = thinMarket({ volume: 18, price: 31_027 }, 0.045, on);
    assert.equal(v.thin, true);
    assert.equal(v.sellImpact, 0.15);
    assert.equal(v.maxUnits, 54);
    assert.match(v.reason ?? "", /thin sell market \(18 a trade at 31027\)/);
  });
  it("leaves a cheap bulk good alone even at a small lot (FAB_MATS at 20 a trade measured 4.5%)", () => {
    const v = thinMarket({ volume: 20, price: 1_500 }, 0.045, on);
    assert.deepEqual([v.thin, v.sellImpact, v.maxUnits], [false, 0.045, Infinity]);
  });
  it("leaves a deep market alone however dear (DRUGS at 35 a trade)", () => {
    assert.equal(thinMarket({ volume: 35, price: 5_000 }, 0.045, on).thin, false);
    assert.equal(thinMarket({ volume: 60, price: 40_000 }, 0.045, on).thin, false);
  });
  it("keeps a learned impact that is already steeper", () => {
    assert.equal(thinMarket({ volume: 18, price: 31_027 }, 0.2, on).sellImpact, 0.2);
  });
  it("off reproduces today's behaviour", () => {
    const v = thinMarket({ volume: 18, price: 31_027 }, 0.045, DEFAULT_THIN_POLICY);
    assert.deepEqual([v.thin, v.sellImpact, v.maxUnits], [false, 0.045, Infinity]);
  });
});

describe("the VIRAL_AGENTS trip of 2026-11-05, sized with and without the rule", () => {
  // THEO-13A bought 90 at about 26,138 a unit and sold into X1-TN61-A1 (18 a trade) from 31,027.
  const input = { buyPrice: 22_000, sellPrice: 31_027, buyVolume: 18, sellVolume: 18, buyImpact: 0.045 };
  const impact = { ...DEFAULT_IMPACT_POLICY, maxFactor: 3 };
  it("without it the planner takes far more than the market's three lots (68 at this buy price; the real trip took 90)", () => {
    assert.ok(sizeForImpact(90, { ...input, sellImpact: 0.045 }, impact).units > 54);
  });
  it("with it the trip is one or two lots", () => {
    const thin = thinMarket({ volume: 18, price: 31_027 }, 0.045, on);
    const units = sizeForImpact(Math.min(90, thin.maxUnits), { ...input, sellImpact: thin.sellImpact }, impact).units;
    assert.ok(units >= 18 && units <= 36, `got ${units}`);
  });
});
