import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profitPerReference, scaledTripSeconds } from "../src/engine/tripScale.js";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Issue #55 (2026-11-19): FUEL X1-DT25-E19A -> F16F, 2,663 a trip on a 15c spread over a ~32 s modelled trip, ranked at 49,931
 * per 600 s, above real ANTIMATTER routes. routeMinTripSeconds floors the trip time used for scaling.
 */
describe("tripScale (pure)", () => {
  const OFF = { referenceSeconds: 600, minTripSeconds: 0 };
  const ON = { referenceSeconds: 600, minTripSeconds: 300 };
  it("off: the old scaling, however short the trip", () => {
    assert.equal(profitPerReference(2_663, 32, OFF), (2_663 * 600) / 32);
  });
  it("on: a trip shorter than the floor is scaled as the floor", () => {
    assert.equal(profitPerReference(2_663, 32, ON), (2_663 * 600) / 300);
  });
  it("on: a trip longer than the floor is unchanged", () => {
    assert.equal(profitPerReference(60_000, 3_600, ON), (60_000 * 600) / 3_600);
  });
  it("no trip time: the trip profit as is", () => {
    assert.equal(profitPerReference(5_000, undefined, ON), 5_000);
    assert.equal(scaledTripSeconds(undefined, ON), undefined);
    assert.equal(scaledTripSeconds(0, ON), undefined);
  });
});

describe("the dispatcher with routeMinTripSeconds (the DT25 FUEL case)", () => {
  const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
  const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));
  const FUEL: DispatchRoute = {
    good: "FUEL", buyAt: "X1-DT-1", sellAt: "X1-DT-2", buySystem: "X1-DT", sellSystem: "X1-DT",
    buyPrice: 53, sellPrice: 68, volume: 180, lotSize: 180, distance: 1, fuelUnits: 1, fuelCost: 1,
    profitPerTrip: 2_663, tripSeconds: 32, secPerDist: 1, ageMinutes: 1,
  } as unknown as DispatchRoute;
  const ANTI: DispatchRoute = {
    good: "ANTIMATTER", buyAt: "X1-DT-10", sellAt: "X1-DT-40", buySystem: "X1-DT", sellSystem: "X1-DT",
    buyPrice: 5_000, sellPrice: 6_500, volume: 80, lotSize: 36, distance: 30, fuelUnits: 30, fuelCost: 30,
    profitPerTrip: 50_000, tripSeconds: 1_800, secPerDist: 1, ageMinutes: 1,
  } as unknown as DispatchRoute;
  const ship = { shipSymbol: "THEO-7", capacity: 80, system: "X1-DT", waypoint: "X1-DT-1", fuelCapacity: 600 };
  const run = (minTripSeconds?: number) => {
    const d = new RouteDispatcher();
    d.recompute([FUEL, ANTI], [ship], [], [], [], [], (a: string, b: string) => a === b, distance, undefined, undefined, undefined, minTripSeconds === undefined ? {} : { minTripSeconds });
    return d.assignmentFor("THEO-7")?.good;
  };
  it("clause off: the 15c FUEL hop wins on its inflated rate (the bug)", () => {
    assert.equal(run(), "FUEL");
  });
  it("clause on (300 s): the 50k ANTIMATTER route wins", () => {
    assert.equal(run(300), "ANTIMATTER");
  });
});
