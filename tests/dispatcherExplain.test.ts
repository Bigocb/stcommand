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
    assert.equal(reason("MEDICINE"), "X1-RD37 is out of reach from X1-KU72");
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
