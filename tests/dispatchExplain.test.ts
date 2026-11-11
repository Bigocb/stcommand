import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";
import { goodOfKey, selectExplain, type DispatchExplainSnapshot } from "../src/engine/dispatchExplain.js";

const snap: DispatchExplainSnapshot = {
  at: 1,
  routes: [
    { key: "FUEL", good: "FUEL", profitPerTrip: 6601, score: 6601, claimedBy: "T-1" },
    { key: "COPPER@X1-B-SELL", good: "COPPER", sellAt: "X1-B-SELL", profitPerTrip: 1005, score: 1005 },
  ],
  floorDropped: [{ key: "DUD", good: "DUD", profitPerTrip: 0, score: 0 }],
  traders: [
    { ship: "T-1", busy: false, assigned: "FUEL", rejected: [{ key: "COPPER@X1-B-SELL", good: "COPPER", reason: "outscored by FUEL" }] },
    { ship: "T-2", busy: true, assigned: "COPPER@X1-B-SELL", rejected: [] },
  ],
};

describe("goodOfKey", () => {
  it("strips the market or side qualifier from a work key", () => {
    assert.equal(goodOfKey("FUEL"), "FUEL");
    assert.equal(goodOfKey("FUEL@X1-A-B"), "FUEL");
    assert.equal(goodOfKey("FUEL:buy"), "FUEL");
  });
});

describe("selectExplain", () => {
  it("with no filter returns the routes and per-trader counts, not the rejection detail", () => {
    const out = selectExplain(snap);
    assert.equal(out.routes.length, 2);
    assert.equal(out.traders[0]!.rejectedCount, 1);
    assert.deepEqual(out.traders[0]!.rejected, []);
  });

  it("filters to one ship and shows its rejections", () => {
    const out = selectExplain(snap, { ship: "T-1" });
    assert.deepEqual(out.traders.map((t) => t.ship), ["T-1"]);
    assert.equal(out.traders[0]!.rejected[0]!.reason, "outscored by FUEL");
  });

  it("filters to one good across routes, floor drops and traders", () => {
    const out = selectExplain(snap, { good: "COPPER" });
    assert.deepEqual(out.routes.map((r) => r.key), ["COPPER@X1-B-SELL"]);
    assert.deepEqual(out.floorDropped, []);
    assert.deepEqual(out.traders.map((t) => t.ship), ["T-1", "T-2"], "T-1 was refused COPPER, T-2 is busy on it");
    assert.equal(out.traders[0]!.rejected.length, 1);
  });

  it("returns an empty trader list for an unknown ship", () => {
    assert.deepEqual(selectExplain(snap, { ship: "NOPE" }).traders, []);
  });

  it("honours the limit", () => {
    assert.equal(selectExplain(snap, { limit: 1 }).routes.length, 1);
  });
});

describe("a slow hull's refusal reaches ops_dispatch_explain", () => {
  // X1-A -> X1-B is the only gate, so the MEDICINE leg crosses two of them. A speed-15 hull must be told why it is not
  // offered that leg (docs/slow-hull-local-routes-spec.md).
  const num = (w: string): number => Number(w.slice(w.lastIndexOf("-") + 1));
  const distance = (a: string, b: string): number => Math.abs(num(a) - num(b));
  const canJump = (from: string, to: string) => (from === "X1-A" && to === "X1-B") || (from === "X1-B" && to === "X1-A");
  const path = (from: string, to: string) =>
    ({ "X1-A>X1-C": ["X1-A", "X1-B", "X1-C"], "X1-C>X1-A": ["X1-C", "X1-B", "X1-A"] } as Record<string, string[]>)[`${from}>${to}`];
  const leg = (good: string, buyAt: string, sellAt: string, profit: number): DispatchRoute => ({
    good, buyAt, sellAt,
    buySystem: buyAt.slice(0, buyAt.lastIndexOf("-")), sellSystem: sellAt.slice(0, sellAt.lastIndexOf("-")),
    buyPrice: 100, sellPrice: 200, volume: 40, lotSize: 20, distance: 10, fuelUnits: 10, fuelCost: 10,
    profitPerTrip: profit, tripSeconds: 600, secPerDist: 1, ageMinutes: 1,
  } as unknown as DispatchRoute);

  it("names the loaded-leg limit for the refused route", () => {
    const d = new RouteDispatcher();
    const routes = [leg("FUEL", "X1-A-10", "X1-A-20", 50_000), leg("MEDICINE", "X1-A-10", "X1-C-20", 500_000)];
    d.recompute(routes, [{ shipSymbol: "SLOW", capacity: 40, speed: 15, system: "X1-A", waypoint: "X1-A-1", fuelCapacity: 5_000 }],
      [], [], [], [], canJump, distance, undefined, undefined,
      { enabled: true, path, hopCost: () => 5_000 }, { slowHullSpeed: 15, slowHullHauledHops: 1 });
    const out = selectExplain(d.explain()!, { ship: "SLOW" });
    const reasons = out.traders[0]!.rejected.map((r) => r.reason);
    assert.ok(reasons.includes("slow hull: loaded leg is 2 gate jumps, over the slow-hull limit of 1"),
      `dispatch_explain must say why the leg was not offered, got ${JSON.stringify(reasons)}`);
  });
});
