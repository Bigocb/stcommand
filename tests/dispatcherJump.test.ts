import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * A trip that needs gate jumps is ranked per unit of time, with the jump cooldown counted (src/engine/chain.ts,
 * JUMP_COOLDOWN_SECONDS). Before, a cross-system route had no trip time and was ranked on raw profit against same-system
 * routes ranked per ten minutes, so it beat them however long the jumps kept the ship busy.
 */
const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const route = (good: string, buyAt: string, sellAt: string, profit: number, system: string, tripSeconds?: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: system, sellSystem: system,
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds, secPerDist: tripSeconds ? 1 : undefined, ageMinutes: 1,
} as unknown as DispatchRoute);

const ship = { shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 5000 };
const LOCAL = route("LOCAL", "X1-A-1", "X1-A-60", 50_000, "X1-A", 600);

function pick(other: DispatchRoute, tuning: { jumpSeconds?: number } = {}) {
  const d = new RouteDispatcher();
  d.recompute([LOCAL, other], [ship], [], [], [], [], () => true, distance, undefined, undefined, undefined, tuning);
  return d.assignmentFor("T-1")?.good;
}

describe("jump cooldown in the plain route score", () => {
  it("a cross-system trip that earns less per minute than the route next door loses to it", () => {
    // 60k on an 840s trip is ~43k per ten minutes, and a 600s jump wait first leaves ~25k
    assert.equal(pick(route("FAR", "X1-B-1", "X1-B-60", 60_000, "X1-B", 840)), "LOCAL");
  });
  it("a cross-system trip that earns enough still wins", () => {
    assert.equal(pick(route("FAR", "X1-B-1", "X1-B-60", 600_000, "X1-B", 840)), "FAR");
  });
  it("a route in the ship's own system is not charged any wait", () => {
    assert.equal(pick(route("NEAR", "X1-A-2", "X1-A-60", 60_000, "X1-A", 600)), "NEAR");
  });
  it("with the wait set to 0 the cross-system trip is ranked on its trip time alone", () => {
    // 75k on an 840s trip is ~54k per ten minutes: over the 50k route when the wait is free, ~31k once it is charged
    const far = route("FAR", "X1-B-1", "X1-B-60", 75_000, "X1-B", 840);
    assert.equal(pick(far, { jumpSeconds: 0 }), "FAR");
    assert.equal(pick(far), "LOCAL");
  });
});
