import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher } from "../src/engine/dispatcher.js";
import { DEFAULT_IMPACT_POLICY } from "../src/engine/lotImpact.js";

/**
 * The lots the recovery pricing and the learned impact are built from survive a restart. Without it every deploy made the
 * dispatcher forget the markets it had just dumped into and plan on the stale snapshot price again.
 */
const MIN = 60_000;
const route = (good: string, sellAt: string, sellPrice: number, profit: number) => ({
  good, buyAt: "X1-A-BUY", buySystem: "X1-A", buyPrice: 4000, sellAt, sellSystem: "X1-A", sellPrice,
  volume: 100, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: profit, ageMinutes: 70,
  profitByHold: { "100": profit, "40": profit * 0.4 } as Record<string, number>,
});
const BD3D = route("LAB_INSTRUMENTS", "X1-A-BD3D", 5836, 180_000);
const OTHER = route("LAB_INSTRUMENTS", "X1-A-OTHER", 5600, 160_000);
const run = (d: RouteDispatcher) =>
  d.recompute([BD3D, OTHER], [{ shipSymbol: "T1", capacity: 100 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, { marketRecoveryMin: 90 });
function dump(d: RouteDispatcher) {
  d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 60, 5836);
  d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 60, 5232);
  d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 40, 4609);
}

describe("trade impacts across a restart", () => {
  it("a fresh dispatcher with the saved lots plans on the same price the old one did", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const old = new RouteDispatcher();
    dump(old);
    old.recordBuy("LAB_INSTRUMENTS", "X1-A-BUY", 40, 4000);
    t.mock.timers.tick(MIN + 1);
    const json = old.impactsSnapshot();
    assert.ok(json && json.includes("X1-A-BD3D"));
    run(old);
    const planned = old.routeList().find((r) => r.sellAt === "X1-A-BD3D");
    assert.ok(planned === undefined || planned.sellPrice < 5836, "the old dispatcher already plans below the pre-sale price");

    // the deploy: a new process, nothing in memory but what was saved
    const fresh = new RouteDispatcher();
    run(fresh);
    assert.equal(fresh.routeList().find((r) => r.sellAt === "X1-A-BD3D")?.sellPrice, 5836, "without the saved lots it plans on the stale snapshot");
    const restarted = new RouteDispatcher();
    assert.ok(restarted.restoreImpacts(json!) >= 4);
    run(restarted);
    assert.deepEqual(restarted.routeList().map((r) => [r.sellAt, r.sellPrice]), old.routeList().map((r) => [r.sellAt, r.sellPrice]));
  });

  it("the learned price impact comes back too", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const old = new RouteDispatcher();
    for (const p of [31832, 29492, 26709, 23399, 19464]) old.recordSale("NEURAL_CHIPS", "X1-X48-A1", 15, p);
    t.mock.timers.tick(MIN + 1);
    const json = old.impactsSnapshot()!;
    const restarted = new RouteDispatcher();
    restarted.restoreImpacts(json);
    const on = { ...DEFAULT_IMPACT_POLICY, maxFactor: 3, maxAgeMs: 4 * 60 * MIN };
    assert.ok(restarted.impactFor("sell", "NEURAL_CHIPS", "X1-X48-A1", 15, on).perLot > 0.1);
  });

  it("writes only when something changed, at most once a minute", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    assert.equal(d.impactsSnapshot(), undefined, "nothing recorded: the empty list is what 'saved' already means");
    dump(d);
    assert.equal(d.impactsSnapshot(), undefined, "inside the first minute");
    t.mock.timers.tick(MIN + 1);
    assert.ok(d.impactsSnapshot());
    t.mock.timers.tick(2 * MIN);
    assert.equal(d.impactsSnapshot(), undefined, "unchanged");
    d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 10, 4500);
    t.mock.timers.tick(MIN + 1);
    assert.ok(d.impactsSnapshot(), "a new lot is written");
  });

  it("drops lots older than the keep window and survives junk", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 100 * 3_600_000 });
    const d = new RouteDispatcher();
    const now = Date.now();
    const old = JSON.stringify({ sales: [["G@X", [[10, now - 5 * 3_600_000, 100], [10, now - MIN, 90]]]], buys: [] });
    assert.equal(d.restoreImpacts(old), 1);
    assert.equal(d.restoreImpacts("not json"), 0);
    assert.equal(d.restoreImpacts('{"sales":"x","buys":[null,["k"],["k",[[1,"a",3]]]]}'), 0);
  });
});
