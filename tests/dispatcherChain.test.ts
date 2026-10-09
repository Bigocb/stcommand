import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Follow-on lookahead (src/engine/chain.ts). Two equal routes from the ship's position; one sells next to a good
 * follow-on trip, the other in a dead end. Weight 0 must behave as before; weight > 0 prefers the first.
 */

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

const trader = { shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 2000 };

function pick(weight: number, routes: DispatchRoute[]) {
  const d = new RouteDispatcher();
  const lines: string[] = [];
  d.recompute(routes, [trader], [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, { followOnWeight: weight });
  return { a: d.assignmentFor("T-1"), lines };
}

describe("dispatcher follow-on lookahead", () => {
  const deadEnd = route("DEADEND", "X1-A-1", "X1-A-1900", 50_100); // a hair richer, so weight 0 picks it
  const leadsOn = route("LEADSON", "X1-A-1", "X1-A-300", 50_000);
  const follower = route("FOLLOWER", "X1-A-300", "X1-A-400", 20_000);
  const routes = [deadEnd, leadsOn, follower];

  it("with weight 0 the pick is exactly the old one", () => {
    const { a } = pick(0, routes);
    assert.equal(a?.good, "DEADEND");
    assert.equal(a?.followOn, undefined);
  });

  it("with weight > 0 it prefers the route that sells next to a follow-on, and records it", () => {
    const { a, lines } = pick(0.5, routes);
    assert.equal(a?.good, "LEADSON");
    assert.ok(a?.followOn && a.followOn.good !== "LEADSON", "a follow-on other than the route itself is recorded");
    assert.ok(lines.some((l) => l.startsWith("dispatch chain: T-1 LEADSON")));
  });

  it("does not credit a follow-on that is the route itself", () => {
    const { a } = pick(0.5, [leadsOn]);
    assert.equal(a?.good, "LEADSON");
    assert.equal(a?.followOn, undefined, "the only route has no other route to follow it");
  });
});
