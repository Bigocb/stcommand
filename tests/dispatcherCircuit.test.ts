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

function run(d: RouteDispatcher, weight: number, routes: DispatchRoute[], traders: ReturnType<typeof t1>[], lines: string[] = [], circuitCash?: number) {
  d.recompute(routes, traders, [], [], [], [], () => false, distance, (m) => lines.push(m), undefined, undefined, { circuitWeight: weight, circuitCash });
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

  it("drops the second leg when the spendable cash would buy under half its load", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    // BACK's buy price is 100 and a load is min(volume 40, hold 40) = 4,000; half of that is 2,000.
    const plan = (cashAfterSale: number) => {
      const d = new RouteDispatcher();
      run(d, 1, [OUT, BACK, SOLO], [t1()]);
      t.mock.timers.tick(60_001);
      run(d, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
      t.mock.timers.tick(60_001);
      const lines: string[] = [];
      run(d, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" })], lines, cashAfterSale);
      return { a: d.assignmentFor("T-1"), lines };
    };
    const rich = plan(10_000);
    assert.equal(rich.a?.good, "BACK");
    assert.equal(rich.a?.circuit?.leg, 2);
    const poor = plan(1_999);
    assert.notEqual(poor.a?.circuit?.leg, 2);
    assert.ok(poor.lines.some((l) => l.includes("dropped leg 2") && l.includes("cash:")));
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

  it("a restart keeps the pending circuit: snapshot, restore, and the second leg is still served", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const before = new RouteDispatcher();
    assert.equal(before.circuitSnapshot(), undefined, "nothing planned, nothing to save");
    run(before, 1, [OUT, BACK, SOLO], [t1()]);
    t.mock.timers.tick(60_001);
    run(before, 1, [OUT, BACK, SOLO], [t1({ busy: true })]);
    const saved = before.circuitSnapshot();
    assert.ok(saved && saved.includes("BACK"));
    assert.equal(before.circuitSnapshot(), undefined, "unchanged since the last save");

    // New process: fresh dispatcher, same saved plan. The ship is mid-leg-1; the fleet passes its held-route pin as inFlight.
    const after = new RouteDispatcher();
    after.restoreCircuits(saved!);
    assert.equal(after.circuitSnapshot(), undefined, "a restored plan is not re-saved");
    const pin = [{ shipSymbol: "T-1", good: "OUT", buyAt: "X1-A-10", sellAt: "X1-A-100", units: 40 }];
    const all = [OUT, BACK, SOLO];
    t.mock.timers.tick(60_001);
    after.recompute(all, [t1({ busy: true }), t2()], [], [], [], [], () => false, distance, undefined, undefined, undefined, { circuitWeight: 1 }, pin);
    assert.notEqual(after.assignmentFor("T-2")?.good, "BACK", "still held after the restart");
    t.mock.timers.tick(60_001);
    run(after, 1, all, [t1({ waypoint: "X1-A-100" }), t2()]); // sold
    assert.equal(after.assignmentFor("T-1")?.good, "BACK");
    assert.equal(after.assignmentFor("T-1")?.circuit?.leg, 2);
  });

  it("a restored plan whose first leg was never seen to run is dropped, not assumed", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const before = new RouteDispatcher();
    run(before, 1, [OUT, BACK, SOLO], [t1()]);
    const after = new RouteDispatcher();
    after.restoreCircuits(before.circuitSnapshot()!);
    t.mock.timers.tick(60_001);
    const lines: string[] = [];
    run(after, 1, [OUT, BACK, SOLO], [t1({ waypoint: "X1-A-100" })], lines);
    assert.notEqual(after.assignmentFor("T-1")?.circuit?.leg, 2);
    assert.ok(lines.some((l) => l.includes("leg 1 never ran")));
  });

  it("ignores a malformed saved plan", () => {
    const d = new RouteDispatcher();
    d.restoreCircuits("not json at all");
    d.restoreCircuits(JSON.stringify([["T-1", { nonsense: true }], 7, null]));
    assert.equal(d.circuitSnapshot(), undefined);
  });

  it("does not credit a circuit whose first leg starts in another system than the ship", () => {
    const inB = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute =>
      ({ ...route(good, buyAt, sellAt, profit), buySystem: "X1-B", sellSystem: "X1-B" }) as DispatchRoute;
    const XOUT = inB("XOUT", "X1-B-10", "X1-B-100", 40_000);
    const XBACK = inB("XBACK", "X1-B-102", "X1-B-12", 42_000);
    const LOCAL = route("LOCAL", "X1-A-1", "X1-A-60", 50_000); // plain route right where the ship stands
    const pick = (weight: number) => {
      const d = new RouteDispatcher();
      d.recompute([XOUT, XBACK, LOCAL], [t1({ waypoint: "X1-A-1" })], [], [], [], [], () => true, distance, undefined, undefined, undefined, { circuitWeight: weight });
      return d.assignmentFor("T-1");
    };
    assert.equal(pick(1)?.good, "LOCAL", "the other system's pair is not over-credited");
    assert.equal(pick(1)?.circuit, undefined);
    assert.equal(pick(0)?.good, "LOCAL");
  });

  it("still credits a circuit whose first leg starts in the ship's own system", () => {
    const d = new RouteDispatcher();
    d.recompute([OUT, BACK, SOLO], [t1()], [], [], [], [], () => true, distance, undefined, undefined, undefined, { circuitWeight: 1 });
    assert.equal(d.assignmentFor("T-1")?.circuit?.leg, 1);
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
