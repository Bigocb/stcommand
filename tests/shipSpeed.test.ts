import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";
import { fitValue } from "../src/engine/matching.js";
import { DEFAULT_SPEED_POLICY, scaleSeconds, speedGain } from "../src/engine/shipSpeed.js";

const on = { ...DEFAULT_SPEED_POLICY, weightPct: 100 };

describe("speedGain", () => {
  it("is 1 when off, when speeds are unknown, and at the modelled speed", () => {
    assert.equal(speedGain(60, 15, DEFAULT_SPEED_POLICY), 1);
    assert.equal(speedGain(undefined, 15, on), 1);
    assert.equal(speedGain(60, 0, on), 1);
    assert.equal(speedGain(15, 15, on), 1);
  });
  it("counts the ratio at full weight, a share at partial weight, and caps it", () => {
    assert.equal(speedGain(60, 15, on), 4);
    assert.equal(speedGain(36, 15, on), 2.4);
    assert.equal(speedGain(60, 15, { ...on, weightPct: 50 }), 2.5);
    assert.equal(speedGain(600, 15, on), 4);
  });
  it("shortens flying time by the gain", () => {
    assert.equal(scaleSeconds(600, 4), 150);
  });
});

describe("fitValue with speed", () => {
  const item = { key: "A", profitPerTrip: 1000, tripSeconds: 600, flightBound: true };
  it("a faster ship is worth more on a flight-bound route, and the same on a gate route", () => {
    const slow = fitValue(item, { shipSymbol: "S", capacity: 40 }, 0);
    const fast = fitValue(item, { shipSymbol: "F", capacity: 40, speedGain: 4 }, 0);
    assert.equal(fast, slow * 4);
    const gate = { ...item, flightBound: false };
    assert.equal(fitValue(gate, { shipSymbol: "F", capacity: 40, speedGain: 4 }, 0), slow);
  });
  it("no speedGain reproduces the old value", () => {
    assert.equal(fitValue(item, { shipSymbol: "S", capacity: 40 }, 300), 1000 * (600 / 900));
  });
});

describe("dispatcher with speed", () => {
  const route = (good: string, profit: number): DispatchRoute => ({
    good, buyAt: "X1-A-400", sellAt: "X1-A-450", buySystem: "X1-A", sellSystem: "X1-A",
    buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
    profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
  } as unknown as DispatchRoute);
  const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
  const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));
  const slow = { shipSymbol: "SLOW", capacity: 40, speed: 15, system: "X1-A", waypoint: "X1-A-400", fuelCapacity: 5000 };
  const fast = { shipSymbol: "FAST", capacity: 40, speed: 60, system: "X1-A", waypoint: "X1-A-400", fuelCapacity: 5000 };
  const run = (d: RouteDispatcher, tuning: Record<string, unknown>, lines: string[] = []) =>
    d.recompute([route("A", 60_000), route("B", 50_000)].map((r, i) => (i ? { ...r, buyAt: "X1-A-500", sellAt: "X1-A-560" } : r)), [slow, fast], [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, tuning);

  it("off: assignment is unchanged and nothing about speed is logged", () => {
    const lines: string[] = [];
    run(new RouteDispatcher(), { modelSpeed: 15 }, lines);
    assert.ok(!lines.some((l) => l.includes("speed")));
  });
  it("on: logs the gain for the faster hull", () => {
    const lines: string[] = [];
    run(new RouteDispatcher(), { speedWeight: 100, modelSpeed: 15 }, lines);
    assert.ok(lines.some((l) => l.includes("FAST speed 60 vs 15 modelled")));
    assert.ok(!lines.some((l) => l.startsWith("SLOW speed")));
  });
});
