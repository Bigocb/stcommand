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

describe("thinMarket dear tier", () => {
  const dear = { ...on, dearPrice: 25_000 };
  it("plans a dear good (RELIC_TECH, 30k at 18 a trade) harder: 25% a lot and two lots", () => {
    const v = thinMarket({ volume: 18, price: 30_000 }, 0.045, dear);
    assert.deepEqual([v.thin, v.sellImpact, v.maxUnits], [true, 0.25, 36]);
    assert.match(v.reason ?? "", /dear/);
  });
  it("leaves a thin good under the dear price on the base limits (15%, three lots)", () => {
    const v = thinMarket({ volume: 18, price: 14_000 }, 0.045, dear);
    assert.deepEqual([v.sellImpact, v.maxUnits], [0.15, 54]);
  });
  it("never loosens the base limits (dear lots above the base cap stay at the base cap)", () => {
    assert.equal(thinMarket({ volume: 18, price: 30_000 }, 0.045, { ...dear, maxLots: 1, dearMaxLots: 4 }).maxUnits, 18);
  });
  it("keeps a steeper learned impact", () => {
    assert.equal(thinMarket({ volume: 18, price: 30_000 }, 0.4, dear).sellImpact, 0.4);
  });
  it("dearPrice 0 (the default) reproduces the base rule", () => {
    const v = thinMarket({ volume: 18, price: 30_000 }, 0.045, on);
    assert.deepEqual([v.sellImpact, v.maxUnits], [0.15, 54]);
  });
  it("a deep market stays untouched however dear", () => {
    assert.equal(thinMarket({ volume: 60, price: 50_000 }, 0.045, dear).thin, false);
  });
  it("sizes RELIC_TECH (bought 30.6k, bid 40k, 18 a trade) to two lots at most; the 54-unit trip at 15% is no longer planned", () => {
    const input = { buyPrice: 30_600, sellPrice: 40_000, buyVolume: 18, sellVolume: 18, buyImpact: 0.045 };
    const impact = { ...DEFAULT_IMPACT_POLICY, maxFactor: 3 };
    const units = (p: typeof on) => { const t = thinMarket({ volume: 18, price: 40_000 }, 0.045, p); return sizeForImpact(Math.min(90, t.maxUnits), { ...input, sellImpact: t.sellImpact }, impact).units; };
    assert.ok(units(dear) <= 36, `dear ${units(dear)}`);
    assert.ok(units(on) >= units(dear));
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
