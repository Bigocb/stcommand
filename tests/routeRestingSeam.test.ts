import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-10-22: THEOREM-A0 ran CLOTHING B10C > ZC9B eleven times in eleven minutes against a round limit of 2 per hour. A busy
 * trader keeps its assignment across dispatcher recomputes, and the rest rules only filtered the dispatcher's NEW work, so a
 * loop as short as the recompute interval was never re-ranked. The trader now asks before it buys a new round.
 */
function trader(opts: { resting?: string; source?: "auto" | "manual" }) {
  const declined: boolean[] = [];
  const ship = {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
  } as unknown as Ship;
  const a = new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    log: () => {},
    assignedRoute: () => ({ shipSymbol: "T-1", good: "MEDICINE", role: "direct", buyAt: "X1-A-M1", sellAt: "X1-A-M2", buyPrice: 100, sellPrice: 900, profitPerTrip: 1000, source: opts.source ?? "auto" }),
    declineRoute: (protectedGood: boolean) => { declined.push(protectedGood); },
    routeResting: () => opts.resting,
  } as any) as any;
  const t = a.priceTable as Map<string, Map<string, any>>;
  t.set("X1-A-M1", new Map([["MEDICINE", { buy: 100, sell: 90, volume: 40 }]]));
  t.set("X1-A-M2", new Map([["MEDICINE", { buy: 950, sell: 900, volume: 40 }]]));
  a.distBetween = () => 10;
  a.getCredits = () => 10_000_000;
  return { a, declined };
}

describe("a trader and a route the dispatcher has rested", () => {
  it("flies its assigned route when nothing rests it", () => {
    const { a, declined } = trader({});
    assert.ok(a.findRoute());
    assert.deepEqual(declined, []);
  });
  it("does not start another round on a resting route, and hands the route back to the dispatcher", () => {
    const { a, declined } = trader({ resting: "resting 30 more min: 2 trips on this route in the last 60 min (limit 2)" });
    assert.equal(a.findRoute(), undefined);
    assert.deepEqual(declined, [false], "declined once, as an ordinary (not protected-good) refusal");
    assert.match(a.whyNotViable({ good: "MEDICINE", role: "direct", buyAt: "X1-A-M1", sellAt: "X1-A-M2", buyPrice: 100, sellPrice: 900 }), /resting 30 more min/);
  });
  it("never vetoes a route the operator pinned by hand", () => {
    const { a, declined } = trader({ resting: "resting 30 more min", source: "manual" });
    assert.ok(a.findRoute());
    assert.deepEqual(declined, []);
  });
});

describe("the dispatcher's round limit, as the trader sees it through FleetManager", () => {
  it("rests the exact route after the limit and leaves other sell markets alone", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    fleet.dispatcher.roundsMax = 2;
    for (let i = 0; i < 2; i++) fleet.dispatcher.recordTrip({ good: "CLOTHING", buyAt: "X1-KG7-B10C", sellAt: "X1-KG7-ZC9B", promised: 50_000, made: 50_000 });
    const resting = fleet.traderOptions("T-1").routeResting;
    assert.match(resting("CLOTHING", "X1-KG7-B10C", "X1-KG7-ZC9B") ?? "", /resting .* 2 trips/);
    assert.equal(resting("CLOTHING", "X1-KG7-B10C", "X1-KG7-E11D"), undefined, "a different sell market is a different route (the buy-market squeeze is a separate matter)");
  });
  it("is silent when both rest clauses are off", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    for (let i = 0; i < 5; i++) fleet.dispatcher.recordTrip({ good: "CLOTHING", buyAt: "B", sellAt: "S", promised: 50_000, made: 1 });
    assert.equal(fleet.traderOptions("T-1").routeResting("CLOTHING", "B", "S"), undefined);
  });
});
