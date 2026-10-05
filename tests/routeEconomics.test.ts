import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectiveMarginFloor, fuelCredits, legTravel, slippageCredits, tripEconomics } from "../src/engine/routeEconomics.js";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

describe("routeEconomics", () => {
  it("a BURN leg burns twice the fuel for roughly half the time", () => {
    const cruise = legTravel(250, 300, 30); // 250 > 300 * 0.375: tank can't afford BURN
    const burn = legTravel(94, 300, 30);
    assert.equal(cruise.burn, false);
    assert.equal(burn.burn, true);
    assert.equal(burn.fuelPerLeg, 188);
    assert.ok(burn.secondsPerLeg < legTravel(94, 0, 30).secondsPerLeg); // fuel-free hull cruises
  });

  it("fuel is priced per 100-fuel block", () => {
    assert.equal(fuelCredits(188, 72), 135.36);
  });

  it("slippage grows with units/tradeVolume and is zero for no units", () => {
    assert.equal(slippageCredits(0, 20, 1000), 0);
    const one = slippageCredits(20, 20, 1000); // a full lot: price moves 4.5%, average half that
    assert.ok(Math.abs(one - 1000 * 20 * 0.0225) < 1e-6);
    assert.ok(slippageCredits(40, 20, 1000) > 3.9 * one);
  });

  it("margin floor scales with price on top of the flat floor", () => {
    assert.equal(effectiveMarginFloor(10, 22), 10);
    assert.equal(effectiveMarginFloor(10, 3000), 60);
  });

  // Measured 2026-10-05 on a 94-unit leg with a 300-tank shuttle: both of these were listed profitable by the old
  // one-way, no-slippage model and actually lost money per round trip.
  it("thin-margin sand and iron legs are no longer profitable", () => {
    const base = { units: 40, distance: 94, fuelPrice: 72, fuelCapacity: 300, speed: 30 };
    const sand = tripEconomics({ ...base, buyPrice: 22, sellPrice: 26, buyVolume: 180, sellVolume: 60 });
    const iron = tripEconomics({ ...base, buyPrice: 124, sellPrice: 129, buyVolume: 60, sellVolume: 60 });
    assert.ok(sand.net < 0, `sand net ${sand.net}`);
    assert.ok(iron.net < 0, `iron net ${iron.net}`);
  });

  it("a fat margin still clears all costs", () => {
    const t = tripEconomics({ units: 40, distance: 94, fuelPrice: 72, fuelCapacity: 300, speed: 30, buyPrice: 1000, sellPrice: 1400, buyVolume: 60, sellVolume: 60 });
    assert.ok(t.net > 14000);
    assert.equal(t.fuelBurned, 376); // both legs, BURN doubled
  });

  it("the dispatcher ranks a short repeating route above a long one with the same profit per trip", () => {
    const mk = (good: string, tripSeconds: number): DispatchRoute => ({
      good, buyAt: "X1-A-1", buySystem: "X1-A", buyPrice: 100, sellAt: "X1-A-2", sellSystem: "X1-A", sellPrice: 200,
      volume: 40, lotSize: 40, distance: 50, fuelUnits: 0, fuelCost: 0, profitPerTrip: 4000, tripSeconds, secPerDist: 10, ageMinutes: 1,
    });
    const d = new RouteDispatcher();
    d.recompute([mk("SLOW", 1200), mk("FAST", 300)], [{ shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 300 }]);
    assert.equal(d.assignmentFor("T-1")?.good, "FAST");
  });
});
