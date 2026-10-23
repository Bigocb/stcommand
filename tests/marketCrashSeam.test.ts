import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

/**
 * Sell-market recovery at its seam: the real dispatcher, a route into a market we just sold into, and sales recorded
 * as a trader reports them (units and the price each lot fetched). 2026-10-23, X1-YB39-BD3D: the route list kept the
 * price from before our dump and sent the next ship in.
 */
const route = (good: string, sellAt: string, sellPrice: number, profit: number) => ({
  good, buyAt: "X1-A-BUY", buySystem: "X1-A", buyPrice: 4000,
  sellAt, sellSystem: "X1-A", sellPrice,
  volume: 100, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0,
  profitPerTrip: profit, ageMinutes: 70, profitByHold: { "100": profit, "40": profit * 0.4 },
});
const BD3D = route("LAB_INSTRUMENTS", "X1-A-BD3D", 5836, 180_000);
const OTHER = route("LAB_INSTRUMENTS", "X1-A-OTHER", 5600, 160_000);

type Tuning = { sellRecoveryMin?: number };
function run(d: RouteDispatcher, routes: ReturnType<typeof route>[], tuning?: Tuning) {
  d.recompute(routes, [{ shipSymbol: "T1", capacity: 100 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, tuning);
}
/** Our dump, as the trader reports it: first lot at the listed price, the last well below. */
function dump(d: RouteDispatcher) {
  d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 60, 5836);
  d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 60, 5232);
  d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 40, 4609);
}

describe("sell-market recovery", () => {
  it("plans on the refilled price an hour after a dump, so the other market now wins", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 60, 5836); // sold 50 minutes ago
    d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 60, 5232);
    d.recordSale("LAB_INSTRUMENTS", "X1-A-BD3D", 40, 4609);
    t.mock.timers.tick(60 * 60_000); // an hour later: the 30-minute volume discount is long gone
    run(d, [BD3D, OTHER], { sellRecoveryMin: 90 });
    const listed = d.routeList();
    assert.equal(listed[0]!.sellAt, "X1-A-OTHER", "BD3D's planned price is below what it was listed at");
    const bd = listed.find((r) => r.sellAt === "X1-A-BD3D");
    assert.ok(bd === undefined || bd.sellPrice < 5836);
  });

  it("drops a route whose trip no longer pays after the dump", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    dump(d);
    run(d, [route("LAB_INSTRUMENTS", "X1-A-BD3D", 5836, 50_000), OTHER], { sellRecoveryMin: 90 });
    assert.deepEqual(d.routeList().map((r) => r.sellAt), ["X1-A-OTHER"], "1,200 a unit on 100 units is 120k, more than the 50k trip earned");
  });

  it("with the clause off the route list is exactly as given", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    dump(d);
    run(d, [BD3D, OTHER], { sellRecoveryMin: 0 });
    const bd = d.routeList().find((r) => r.sellAt === "X1-A-BD3D")!;
    assert.equal(bd.sellPrice, 5836);
    assert.equal(bd.profitPerTrip, 180_000);
  });

  it("leaves a market we have not sold into alone", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    dump(d);
    run(d, [OTHER], { sellRecoveryMin: 90 });
    assert.equal(d.routeList()[0]!.sellPrice, 5600);
  });
});
