import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

/**
 * dispatch_explain: the dispatcher keeps, per recompute, the work it ranked and
 * the reason each idle trader was refused each route. These tests pin the
 * reasons to the decisions the assignment loop actually makes.
 */

const route = (good: string, sys: string, profit: number, buyPrice = 10, sellPrice = 100): DispatchRoute => ({
  good,
  buyAt: `${sys}-BUY`, sellAt: `${sys}-SELL`,
  buySystem: sys, sellSystem: sys,
  buyPrice, sellPrice, profitPerTrip: profit,
} as unknown as DispatchRoute);

const canJump = () => false;

describe("dispatcher explain snapshot", () => {
  it("is absent until the first recompute", () => {
    assert.equal(new RouteDispatcher().explain(), undefined);
  });

  it("records why an idle trader got the route it got and not the others", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [route("MEDICINE", "X1-RD37", 18072), route("FUEL", "X1-KU72", 6601), route("COPPER", "X1-KU72", 1005)],
      [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72", waypoint: "X1-KU72-A1" }],
      [], [], [], [], canJump,
    );
    const snap = d.explain()!;
    const t1 = snap.traders.find((t) => t.ship === "T-1")!;
    assert.equal(t1.assigned, "FUEL@X1-KU72-SELL");
    const reason = (key: string) => t1.rejected.find((r) => r.key === key)?.reason;
    assert.equal(reason("MEDICINE"), "X1-RD37 is not one gate from X1-KU72 and cross-system routes are off");
    assert.equal(reason("COPPER"), "outscored by FUEL");
    assert.equal(reason("FUEL"), undefined, "the chosen route is not a rejection");
  });

  it("names the route's claimant on the work list", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [route("FUEL", "X1-KU72", 6601)],
      [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72", waypoint: "X1-KU72-A1" }],
      [], [], [], [], canJump,
    );
    const fuel = d.explain()!.routes.find((r) => r.good === "FUEL")!;
    assert.equal(fuel.claimedBy, "T-1");
    assert.equal(fuel.profitPerTrip, 6601);
  });

  it("lists routes dropped under the margin floor separately", () => {
    const d = new RouteDispatcher();
    d.recompute(
      [route("FUEL", "X1-KU72", 6601), route("DUD", "X1-KU72", 0, 100, 100)],
      [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72", waypoint: "X1-KU72-A1" }],
      [], [], [], [], canJump,
    );
    const snap = d.explain()!;
    assert.deepEqual(snap.floorDropped.map((r) => r.good), ["DUD"]);
    assert.ok(!snap.routes.some((r) => r.good === "DUD"), "a dropped route is not on the work list");
  });

  describe("reasons for a cross-system route", () => {
    const far = { shipSymbol: "T-1", capacity: 40, system: "X1-A", waypoint: "X1-A-P1", fuelCapacity: 100 };
    const remote = route("GOOD", "X1-C", 5000);
    const reasonFor = (d: RouteDispatcher, ship: string, key: string) =>
      d.explain()!.traders.find((t) => t.ship === ship)!.rejected.find((r) => r.key === key)?.reason;

    it("says cross-system routes are off when the switch is off", () => {
      const d = new RouteDispatcher();
      d.recompute([remote], [far], [], [], [], [], canJump, () => 0, undefined, undefined,
        { enabled: false, path: () => undefined, hopCost: () => 0 });
      assert.match(reasonFor(d, "T-1", "GOOD")!, /cross-system routes are off/);
    });

    it("says no finished gate path exists within the jump limit", () => {
      const d = new RouteDispatcher();
      d.recompute([remote], [far], [], [], [], [], canJump, () => 0, undefined, undefined,
        { enabled: true, path: () => undefined, hopCost: () => 0 });
      assert.match(reasonFor(d, "T-1", "GOOD")!, /no finished gate path from X1-A to X1-C/);
    });

    it("names the intermediate gate whose relay is beyond the tank", () => {
      // X1-A -> X1-B -> X1-C. Every gate is in fuel range from the ship except the two gates inside X1-B, 500 apart.
      const gateFor = (from: string, to: string) => `${from}-TO-${to}`;
      const distanceBetween = (a: string, b: string) => (a.startsWith("X1-B-") && b.startsWith("X1-B-") ? 500 : 0);
      const d = new RouteDispatcher();
      d.recompute([remote], [far], [], [], [], [], canJump, distanceBetween, undefined, undefined,
        { enabled: true, path: () => ["X1-A", "X1-B", "X1-C"], hopCost: () => 0, gateFor });
      assert.match(reasonFor(d, "T-1", "GOOD")!, /relay through X1-B from X1-B-TO-X1-A to X1-B-TO-X1-C/);
    });
  });

  it("sends the route to the ship nearest its gate, not the first of two equal ships in the system", () => {
    // Both ships sit one jump from X1-B, so the jump count alone cannot tell them apart. The far ship is listed
    // first, which is what the old tie-break picked.
    const far = { shipSymbol: "FAR", capacity: 40, system: "X1-A", waypoint: "X1-A-FAR", fuelCapacity: 400 };
    const near = { shipSymbol: "NEAR", capacity: 40, system: "X1-A", waypoint: "X1-A-NEAR", fuelCapacity: 400 };
    const crossRoute = { ...route("GOOD", "X1-B", 5000), buyAt: "X1-B-BUY", sellAt: "X1-B-SELL", tripSeconds: 3600, secPerDist: 1 } as DispatchRoute;
    const distanceBetween = (a: string, b: string) => (a === "X1-A-FAR" ? 500 : a === "X1-A-NEAR" ? 10 : 0);
    const d = new RouteDispatcher();
    d.recompute([crossRoute], [far, near], [], [], [], [], (f, t) => f === "X1-A" && t === "X1-B", distanceBetween, undefined, undefined,
      { enabled: true, path: () => ["X1-A", "X1-B"], hopCost: () => 0, gateFor: (from: string) => `${from}-GATE` });
    assert.equal(d.assignmentFor("NEAR")?.good, "GOOD");
    assert.equal(d.assignmentFor("FAR"), undefined);
  });

  it("keeps the snapshot from the latest cycle only", () => {
    const d = new RouteDispatcher();
    d.recompute([route("FUEL", "X1-KU72", 6601)], [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72", waypoint: "X1-KU72-A1" }], [], [], [], [], canJump);
    const first = d.explain()!.at;
    // A second recompute inside the 60s throttle is a no-op, so the snapshot must not move.
    d.recompute([route("COPPER", "X1-KU72", 1005)], [{ shipSymbol: "T-1", capacity: 40, system: "X1-KU72", waypoint: "X1-KU72-A1" }], [], [], [], [], canJump);
    assert.equal(d.explain()!.at, first);
    assert.ok(d.explain()!.routes.some((r) => r.good === "FUEL"));
  });
});
