import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";
import { routeRefusedEvent } from "../src/engine/actionEvents.js";

/**
 * 2026-11-18: THEO-1 (40 cargo) made 32 gate jumps between two buys, turning back on itself, and the in-memory log had rolled
 * over before anyone could see why its target kept changing. A trader's refusal of a route is now written to action_events
 * (kind route_refused) with the cash and hold it saw.
 */
function trader(opts: { credits: number; buyPrice?: number }) {
  const refused: any[] = [];
  const declined: boolean[] = [];
  const ship = {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
  } as unknown as Ship;
  const buy = opts.buyPrice ?? 100;
  const a = new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    log: () => {},
    assignedRoute: () => ({ shipSymbol: "T-1", good: "MEDICINE", role: "direct", buyAt: "X1-A-M1", sellAt: "X1-A-M2", buyPrice: buy, sellPrice: 900, profitPerTrip: 1000, source: "auto" }),
    declineRoute: (protectedGood: boolean) => { declined.push(protectedGood); },
    onRouteRefused: (r: any) => { refused.push(r); },
  } as any) as any;
  const t = a.priceTable as Map<string, Map<string, any>>;
  t.set("X1-A-M1", new Map([["MEDICINE", { buy, sell: 90, volume: 40 }]]));
  t.set("X1-A-M2", new Map([["MEDICINE", { buy: 950, sell: 900, volume: 40 }]]));
  a.distBetween = () => 10;
  a.getCredits = () => opts.credits;
  return { a, refused, declined };
}

describe("route refusals are recorded", () => {
  it("records nothing when the trader flies its assignment", () => {
    const { a, refused, declined } = trader({ credits: 10_000_000 });
    assert.ok(a.findRoute());
    assert.deepEqual(refused, []);
    assert.deepEqual(declined, []);
  });

  it("records a cash-limited refusal with the credits and hold the trader saw, and still declines it", () => {
    // 50c of cash cannot buy one 100c unit: the assignment fails the trader's own check.
    const { a, refused, declined } = trader({ credits: 50 });
    assert.equal(a.findRoute(), undefined);
    assert.deepEqual(declined, [false]);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].stage, "assigned");
    assert.equal(refused[0].good, "MEDICINE");
    assert.equal(refused[0].buyAt, "X1-A-M1");
    assert.equal(refused[0].sellAt, "X1-A-M2");
    assert.equal(refused[0].credits, 50);
    assert.equal(refused[0].cargoCapacity, 40);
    assert.match(refused[0].reason, /volume=0|credits=50/);
  });

  it("a failing recorder never changes what the trader does", () => {
    const { a, declined } = trader({ credits: 50 });
    a.onRouteRefused = () => { throw new Error("db down"); };
    assert.equal(a.findRoute(), undefined);
    assert.deepEqual(declined, [false]);
  });
});

describe("routeRefusedEvent", () => {
  it("builds a route_refused row with the stage, cash and hold in context", () => {
    const e = routeRefusedEvent({ shipSymbol: "THEO-1", good: "ANTIMATTER", buyAt: "X1-KJ19-I56", sellAt: "X1-AC26-I63", stage: "assigned", reason: "volume=0 lotSize=20 cargo=40 credits=95467", credits: 95467.4, cargoCapacity: 40, waypoint: "X1-AC26-I63", atIso: "2026-11-18T02:30:00.000Z" });
    assert.equal(e.kind, "route_refused");
    assert.equal(e.actor, "engine");
    assert.equal(e.shipSymbol, "THEO-1");
    assert.equal(e.subject, "X1-KJ19-I56>X1-AC26-I63");
    assert.deepEqual(e.context, { stage: "assigned", credits: 95467, cargoCapacity: 40 });
    assert.match(e.reason ?? "", /^assigned: volume=0/);
  });
  it("keeps an unknown cash figure as null", () => {
    const e = routeRefusedEvent({ shipSymbol: "S", good: "G", buyAt: "A", stage: "arrival_sink", reason: "bid fell", credits: Infinity, atIso: "2026-11-18T00:00:00.000Z" });
    assert.equal((e.context as any).credits, null);
    assert.equal(e.subject, "A>?");
  });
});

describe("the fleet wires refusals into action_events", () => {
  it("traderOptions().onRouteRefused records a route_refused action for that ship", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    const recorded: any[] = [];
    fleet.recordAction = (e: any) => { recorded.push(e); };
    fleet.traderOptions("THEO-1").onRouteRefused({ good: "ANTIMATTER", buyAt: "X1-KJ19-I56", sellAt: "X1-AC26-I63", stage: "arrival_price", reason: "buy price now 5400c", credits: 120000, cargoCapacity: 40 });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, "route_refused");
    assert.equal(recorded[0].shipSymbol, "THEO-1");
    assert.equal((recorded[0].context as any).stage, "arrival_price");
  });
});
