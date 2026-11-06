import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cannotProfit, netCeiling } from "../src/engine/routePrefilter.js";
import { tripEconomics, legTravel, fuelCredits } from "../src/engine/routeEconomics.js";

describe("routePrefilter", () => {
  it("rules out a leg whose spread on the largest load does not cover the fixed cost", () => {
    assert.equal(cannotProfit({ buyPrice: 100, sellPrice: 110, unitsCeiling: 40, fixedCost: 500 }), true); // 400 < 500
    assert.equal(cannotProfit({ buyPrice: 100, sellPrice: 110, unitsCeiling: 40, fixedCost: 400 }), true); // exactly zero is not profit
    assert.equal(cannotProfit({ buyPrice: 100, sellPrice: 110, unitsCeiling: 40, fixedCost: 399 }), false);
  });

  it("keeps a leg that has room to profit, and a leg with no cost", () => {
    assert.equal(cannotProfit({ buyPrice: 100, sellPrice: 200, unitsCeiling: 80, fixedCost: 0 }), false);
  });

  it("rules out a leg that can carry nothing", () => {
    assert.equal(cannotProfit({ buyPrice: 100, sellPrice: 500, unitsCeiling: 0, fixedCost: 0 }), true);
    assert.equal(netCeiling({ buyPrice: 100, sellPrice: 500, unitsCeiling: -5, fixedCost: 10 }), -10);
  });

  it("never rules out a leg the full pricing finds profitable (same-system, many random legs)", () => {
    let seed = 12345;
    const rand = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    let kept = 0;
    let dropped = 0;
    for (let n = 0; n < 20_000; n++) {
      const buyPrice = 1 + Math.floor(rand() * 3000);
      const sellPrice = buyPrice + 1 + Math.floor(rand() * 600);
      const buyVolume = 1 + Math.floor(rand() * 100);
      const sellVolume = 1 + Math.floor(rand() * 100);
      const distance = 1 + Math.floor(rand() * 400);
      const fuelPrice = 40 + Math.floor(rand() * 200);
      const fuelCapacity = Math.floor(rand() * 1200);
      const speed = 1 + Math.floor(rand() * 40);
      const unitsCeiling = Math.floor(rand() * 200);
      // The units actually planned are never above the ceiling; the impacts are never below the default (zero here is the lowest).
      const units = Math.floor(rand() * (unitsCeiling + 1));
      const t = tripEconomics({
        buyPrice, sellPrice, units, buyVolume, sellVolume, distance, fuelPrice, fuelCapacity, speed,
        buyImpact: rand() * 0.3, sellImpact: rand() * 0.3,
      });
      const fixedCost = fuelCredits(legTravel(distance, fuelCapacity, speed).fuelPerLeg * 2, fuelPrice);
      const verdict = cannotProfit({ buyPrice, sellPrice, unitsCeiling, fixedCost });
      if (Math.round(t.net) > 0) {
        assert.equal(verdict, false, `a profitable leg was ruled out: ${JSON.stringify({ buyPrice, sellPrice, units, unitsCeiling, fixedCost, net: t.net })}`);
        kept++;
      } else if (verdict) dropped++;
    }
    assert.ok(kept > 100, "the sample must include profitable legs");
    assert.ok(dropped > 100, "the sample must include legs the prefilter drops");
  });

  it("agrees with the full pricing's fuel cost: the fixed cost used equals tripEconomics's own", () => {
    const distance = 120;
    const fuelPrice = 90;
    const fuelCapacity = 600;
    const speed = 15;
    const t = tripEconomics({ buyPrice: 10, sellPrice: 20, units: 10, buyVolume: 20, sellVolume: 20, distance, fuelPrice, fuelCapacity, speed });
    assert.equal(fuelCredits(legTravel(distance, fuelCapacity, speed).fuelPerLeg * 2, fuelPrice), t.fuelCost);
  });
});
