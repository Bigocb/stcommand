import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-11-18: with no dispatcher assignment a trader claimed the first route on the fleet-wide list it could fly, priced
 * without the jumps to the buy market and not held between hops, so empty traders zigzagged across gates (41 claims in
 * 80 minutes, 3 bought anything). Doctrine traderSelfClaim (off by default) now gates the fallback, and a claimed trip is
 * recorded with source "claim" so its results can be measured.
 */
describe("traderSelfClaim gates the trader's own route claim", () => {
  it("is off by default: the trader's claimRoute returns nothing and the dispatcher is not asked", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    let asked = 0;
    fleet.dispatcher.claim = () => { asked++; return undefined; };
    assert.equal(fleet.doctrine.isEnabled("traderSelfClaim"), false);
    assert.equal(fleet.traderOptions("THEO-1").claimRoute(() => true), undefined);
    assert.equal(asked, 0);
  });

  it("with the clause on, the claim goes to the dispatcher as before", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    const leg = { shipSymbol: "THEO-1", good: "IRON", role: "direct", buyAt: "X1-A-M1", sellAt: "X1-A-M2", buyPrice: 10, sellPrice: 20, profitPerTrip: 100, source: "auto" };
    fleet.dispatcher.claim = () => leg;
    const isEnabled = fleet.doctrine.isEnabled.bind(fleet.doctrine);
    fleet.doctrine.isEnabled = (k: string) => k === "traderSelfClaim" ? true : isEnabled(k);
    assert.deepEqual(fleet.traderOptions("THEO-1").claimRoute(() => true), leg);
  });
});

describe("a self-claimed trip is recorded with source claim", () => {
  function trader(claim: boolean) {
    const recorded: any[] = [];
    const ship = {
      symbol: "T-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const leg = { shipSymbol: "T-1", good: "MEDICINE", role: "direct", buyAt: "X1-A-M1", sellAt: "X1-A-M2", buyPrice: 100, sellPrice: 900, profitPerTrip: 1000, source: "auto" };
    const a = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      log: () => {},
      assignedRoute: () => (claim ? undefined : leg),
      claimRoute: () => (claim ? leg : undefined),
      recordAction: (e: any) => { recorded.push(e); },
    } as any) as any;
    const t = a.priceTable as Map<string, Map<string, any>>;
    t.set("X1-A-M1", new Map([["MEDICINE", { buy: 100, sell: 90, volume: 40 }]]));
    t.set("X1-A-M2", new Map([["MEDICINE", { buy: 950, sell: 900, volume: 40 }]]));
    a.distBetween = () => 10;
    a.getCredits = () => 10_000_000;
    return { a, recorded };
  }

  it("tags the trip claim when the route came from the trader's own claim", () => {
    const { a, recorded } = trader(true);
    const route = a.findRoute();
    assert.ok(route);
    a.notePlannedTrip(route, 40, 4000);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].context?.source ?? recorded[0].source, "claim");
  });

  it("keeps auto for a dispatcher assignment", () => {
    const { a, recorded } = trader(false);
    const route = a.findRoute();
    assert.ok(route);
    a.notePlannedTrip(route, 40, 4000);
    assert.equal(recorded[0].context?.source ?? recorded[0].source, "auto");
  });
});
