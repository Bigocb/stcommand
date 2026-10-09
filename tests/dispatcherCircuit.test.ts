import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * Two-leg circuits (src/engine/circuit.ts) through the dispatcher. OUT (10 -> 100) pairs with BACK (102 -> 12), which
 * starts where OUT sells and ends where OUT began; SOLO (10 -> 900) is a slightly richer route with no partner.
 * Weight 0 must behave as before; weight > 0 prefers OUT, keeps BACK for that ship and serves it after the sale.
 */

const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));

const route = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
  good, buyAt, sellAt, buySystem: "X1-A", sellSystem: "X1-A",
  buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
  profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
} as unknown as DispatchRoute);

const OUT = route("OUT", "X1-A-10", "X1-A-100", 40_000);
const BACK = route("BACK", "X1-A-102", "X1-A-12", 42_000);
const SOLO = route("SOLO", "X1-A-10", "X1-A-900", 45_000);

const t1 = (over: Record<string, unknown> = {}) => ({ shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-10", fuelCapacity: 5000, ...over });
const t2 = (over: Record<string, unknown> = {}) => ({ shipSymbol: "T-2", capacity: 20, system: "X1-A", waypoint: "X1-A-102", fuelCapacity: 5000, ...over });

function run(d: RouteDispatcher, weight: number, routes: DispatchRoute[], traders: ReturnType<typeof t1>[], lines: string[] = []) {
  d.recompute(routes, traders, [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, { circuitWeight: weight });
}

describe("dispatcher circuits", () => {
  it("with weight 0 the pick is exactly the old one and nothing is planned", () => {
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, 0, [OUT, BACK, SOLO], [t1(), t2()], lines);
    assert.equal(d.assignmentFor("T-1")?.good, "SOLO");
    assert.equal(d.assignmentFor("T-1")?.circuit, undefined);
    assert.ok(!lines.some((l) => l.includes("dispatch circuit")));
    // control for the tests below: with the feature off, T-2 (standing at BACK's buy market) takes BACK
    assert.equal(d.assignmentFor("T-2")?.good, "BACK");
  });

  it("with weight > 0 it prefers the route with a return leg, records it, and keeps that leg from other ships", () => {
    const d = new RouteDispatcher();
    const lines: string[] = [];
    run(d, 1, [OUT, BACK, SOLO], [t1(), t2()], lines);
    const a = d.assignmentFor("T-1");
    assert.equal(a?.good, "OUT");
    assert.equal(a?.circuit?.leg, 1);
    assert.equal(a?.circuit?.leg2.good, "BACK");
    assert.ok(lines.some((l) => l.startsWith("dispatch circuit: T-1 OUT")));
    // T-2 stands next to BACK's buy market and would take it, but it is kept for T-1.
    assert.notEqual(d.assignmentFor("T-2")?.good, "BACK");
  });

  it("serves the second leg once the first has been sold", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1(), t2()]);
    assert.equal(d.assignmentFor("T-1")?.good, "OUT");

    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()]); // loaded: leg 1 under way
    assert.equal(d.assignmentFor("T-1")?.good, "OUT");
    assert.notEqual(d.assignmentFor("T-2")?.good, "BACK");

    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" }), t2()], lines); // sold, empty again at the sell market
    const a = d.assignmentFor("T-1");
    assert.equal(a?.good, "BACK");
    assert.equal(a?.circuit?.leg, 2);
    assert.ok(lines.some((l) => l.startsWith("dispatch circuit: T-1 leg 2")));
  });

  it("drops the second leg when its margin has collapsed, and picks like any idle trader", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    const weakBack = route("BACK", "X1-A-102", "X1-A-12", 10_000); // under half of the planned 42,000
    run(d, 1, [OUT, weakBack, SOLO], [t1({ waypoint: "X1-A-100" })], lines);
    assert.notEqual(d.assignmentFor("T-1")?.circuit?.leg, 2);
    assert.ok(lines.some((l) => l.includes("dropped leg 2") && l.includes("fell to")));
  });

  it("keeps the second leg from a ship that shows up later, until the plan expires", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const early = new RouteDispatcher();
    run(early, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(10 * 60_000);
    run(early, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()]);
    assert.equal(early.assignmentFor("T-2")?.good, "SOLO", "BACK is held for T-1 while its plan is fresh");

    const late = new RouteDispatcher();
    run(late, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(61 * 60_000);
    run(late, 1, [OUT, BACK, SOLO], [t1({ busy: true }), t2()]);
    assert.equal(late.assignmentFor("T-2")?.good, "BACK", "the held leg is released once the plan has expired");
  });

  it("switching the weight back to 0 releases every held leg", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(d, 0, [OUT, BACK, SOLO], [t1({ busy: true }), t2()], lines);
    assert.ok(!lines.some((l) => l.includes("dispatch circuit")));
    assert.equal(d.assignmentFor("T-2")?.good, "BACK", "BACK is no longer held for T-1");
  });

  it("replaces the follow-on credit for a route that has a circuit", () => {
    const d = new RouteDispatcher();
    d.recompute([OUT, BACK, SOLO], [t1()], [], [], [], [], () => false, distance, undefined, undefined, undefined, { followOnWeight: 0.5, circuitWeight: 1 });
    const a = d.assignmentFor("T-1");
    assert.equal(a?.good, "OUT");
    assert.equal(a?.circuit?.leg, 1);
    assert.equal(a?.followOn, undefined);
  });

  it("a declined or released first leg gives up its second leg", () => {
    const d = new RouteDispatcher();
    run(d, 1, [OUT, BACK, SOLO], [t1()]);
    assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 1);
    d.release("T-1");
    // nothing remembers T-1's plan any more, so a fresh cycle (past the throttle) can hand BACK to another ship
    (d as unknown as { lastComputed: number }).lastComputed = 0;
    run(d, 1, [BACK], [t2()]);
    assert.equal(d.assignmentFor("T-2")?.good, "BACK");
  });
});
