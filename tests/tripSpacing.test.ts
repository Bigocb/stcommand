import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spacingReason } from "../src/engine/tripSpacing.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

const NOW = 10_000_000;
const MIN = 60_000;
const start = (minAgo: number, over: Partial<{ good: string; buyAt: string; shipSymbol: string }> = {}) =>
  ({ good: "FABRICS", buyAt: "X1-A-E49", shipSymbol: "S1", at: NOW - minAgo * MIN, ...over });
const POLICY = { minGapMin: 30 };

describe("trip spacing: the pure rule", () => {
  it("rests the buy market for the gap after a trip started there", () => {
    const why = spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY);
    assert.match(why ?? "", /spacing/);
    assert.match(why ?? "", /4 min ago/);
    assert.match(why ?? "", /next may start in 26 min/);
  });

  it("lets a trip start once the gap has passed", () => {
    assert.equal(spacingReason([start(31)], "FABRICS", "X1-A-E49", NOW, POLICY), undefined);
  });

  it("is per good and per buy market", () => {
    assert.equal(spacingReason([start(4)], "CLOTHING", "X1-A-E49", NOW, POLICY), undefined, "another good at the same market");
    assert.equal(spacingReason([start(4)], "FABRICS", "X1-A-OTHER", NOW, POLICY), undefined, "the same good at another market");
  });

  it("never rests the ship that made the start", () => {
    assert.equal(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, "S1"), undefined);
    assert.match(spacingReason([start(4)], "FABRICS", "X1-A-E49", NOW, POLICY, "S2") ?? "", /spacing/);
  });

  it("counts the latest start, not the first", () => {
    const why = spacingReason([start(25), start(2, { shipSymbol: "S2" })], "FABRICS", "X1-A-E49", NOW, POLICY);
    assert.match(why ?? "", /2 min ago/);
  });

  it("is off at 0 minutes: today's behaviour", () => {
    assert.equal(spacingReason([start(1)], "FABRICS", "X1-A-E49", NOW, { minGapMin: 0 }), undefined);
  });
});

const route = (good: string, sellAt: string, profit: number) => ({
  good, buyAt: "X1-A-E49", buySystem: "X1-A", buyPrice: 100,
  sellAt, sellSystem: "X1-A", sellPrice: 100 + profit,
  volume: 40, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0,
  profitPerTrip: profit, ageMinutes: 1,
});

describe("trip spacing at the dispatcher seam", () => {
  const F1 = route("FABRICS", "X1-A-S1", 900);
  const F2 = route("FABRICS", "X1-A-S2", 700);
  const C = route("CLOTHING", "X1-A-S3", 500);
  function run(d: RouteDispatcher, routes: ReturnType<typeof route>[], spacingMin?: number) {
    d.recompute(routes, [{ shipSymbol: "T1", capacity: 40 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, spacingMin === undefined ? undefined : { spacingMin });
  }

  it("drops every route out of a buy market where a trip just started, whatever it sells into", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTripStart("FABRICS", "X1-A-E49", "T9");
    run(d, [F1, F2, C], 30);
    assert.deepEqual(d.routeList().map((r) => r.good), ["CLOTHING"], "both FABRICS routes rest, CLOTHING from the same market does not");
  });

  it("leaves the starting ship's own check alone but rests everyone else", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTripStart("FABRICS", "X1-A-E49", "T9");
    run(d, [F1], 30);
    assert.equal(d.routeCoolOff("FABRICS", "X1-A-E49", "X1-A-S1", undefined, "T9"), undefined);
    assert.match(d.routeCoolOff("FABRICS", "X1-A-E49", "X1-A-S1", undefined, "T2") ?? "", /spacing/);
  });

  it("reopens after the gap", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTripStart("FABRICS", "X1-A-E49", "T9");
    t.mock.timers.tick(31 * MIN);
    run(d, [F1], 30);
    assert.deepEqual(d.routeList().map((r) => r.good), ["FABRICS"]);
  });

  it("with the clause off (0 or no tuning) the list is exactly as before", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    d.recordTripStart("FABRICS", "X1-A-E49", "T9");
    run(d, [F1, F2, C], 0);
    assert.deepEqual(d.routeList().map((r) => r.good).sort(), ["CLOTHING", "FABRICS", "FABRICS"]);
    const e = new RouteDispatcher();
    e.recordTripStart("FABRICS", "X1-A-E49", "T9");
    run(e, [F1, F2, C]);
    assert.equal(e.routeList().length, 3);
  });
});
