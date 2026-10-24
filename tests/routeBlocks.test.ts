import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BLOCK_POLICY, RouteBlocks, buyKey, legKey } from "../src/engine/routeBlocks.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

const MIN = 60_000;
const on = { ttlMin: 30 };
const eq = { good: "EQUIPMENT", buyAt: "X1-KG7-DD5E", sellAt: "X1-KG7-AA8B" };

describe("routeBlocks (pure)", () => {
  it("is off at ttl 0: nothing is recorded, nothing is blocked", () => {
    const b = new RouteBlocks();
    b.report(eq.good, eq.buyAt, undefined, "buy price moved", 1_000, DEFAULT_BLOCK_POLICY);
    assert.equal(b.reasonFor(eq, 1_001), undefined);
    assert.deepEqual(b.list(1_001), []);
  });

  it("a buy-market report blocks every destination from it, until the block lapses", () => {
    const b = new RouteBlocks();
    b.report(eq.good, eq.buyAt, undefined, "buy price now 2508c", 0, on);
    assert.match(b.reasonFor(eq, 10 * MIN)!, /buy price now 2508c \(reported dead, 20 min left\)/);
    assert.ok(b.reasonFor({ ...eq, sellAt: "X1-KG7-ZZ9" }, 10 * MIN), "another destination from the same buy market");
    assert.equal(b.reasonFor({ ...eq, buyAt: "X1-KG7-OTHER" }, 10 * MIN), undefined, "another buy market");
    assert.equal(b.reasonFor(eq, 31 * MIN), undefined, "lapsed");
    assert.equal(b.prune(31 * MIN), 0);
  });

  it("a destination report blocks that pair only, and repeat reports extend it and count", () => {
    const b = new RouteBlocks();
    b.report(eq.good, eq.buyAt, eq.sellAt, "bid refused", 0, on);
    assert.ok(b.reasonFor(eq, MIN));
    assert.equal(b.reasonFor({ ...eq, sellAt: "X1-KG7-ZZ9" }, MIN), undefined);
    b.report(eq.good, eq.buyAt, eq.sellAt, "bid refused", 20 * MIN, on);
    assert.ok(b.reasonFor(eq, 45 * MIN), "the second report pushed the end out");
    assert.deepEqual(b.list(45 * MIN).map((x) => [x.key, x.reports]), [[legKey(eq.good, eq.buyAt, eq.sellAt), 2]]);
    assert.equal(buyKey("A", "B"), "A@B");
  });
});

const route = (good: string, buyAt: string, sellAt: string, profit: number) => ({
  good, buyAt, buySystem: "X1-KG7", buyPrice: 2000, sellAt, sellSystem: "X1-KG7", sellPrice: 3000,
  volume: 100, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: profit, ageMinutes: 5,
  profitByHold: { "100": profit } as Record<string, number>,
});
const DEAD = route("EQUIPMENT", "X1-KG7-DD5E", "X1-KG7-AA8B", 90_000);
const GOOD = route("EQUIPMENT", "X1-KG7-OK1", "X1-KG7-AA8B", 60_000);
type Tuning = { routeBlockMin?: number };
const run = (d: RouteDispatcher, tuning?: Tuning, ships: { shipSymbol: string; capacity: number }[] = [{ shipSymbol: "T1", capacity: 100 }]) =>
  d.recompute([DEAD, GOOD], ships, [], [], [], [], undefined, undefined, undefined, undefined, undefined, tuning);

describe("dead routes at the dispatcher", () => {
  it("a route one ship found dead is not handed to the next ship", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    run(d, { routeBlockMin: 30 }, []); // a cycle with no ship: sets the policy on this dispatcher
    t.mock.timers.tick(61_000);
    d.reportDeadRoute("EQUIPMENT", "X1-KG7-DD5E", undefined, "buy price now 2508c");
    assert.match(d.deadRouteReason("EQUIPMENT", "X1-KG7-DD5E", "X1-KG7-AA8B")!, /buy price now 2508c/, "a ship already on its way can ask");
    assert.equal(d.deadRouteReason("EQUIPMENT", "X1-KG7-OK1", "X1-KG7-AA8B"), undefined);
    run(d, { routeBlockMin: 30 });
    assert.deepEqual(d.routeList().map((r) => r.buyAt), ["X1-KG7-OK1"]);
    assert.equal(d.assignmentFor("T1")?.buyAt, "X1-KG7-OK1");
    assert.equal(d.deadRouteList()[0]!.key, "EQUIPMENT@X1-KG7-DD5E");
  });

  it("comes back when the block lapses", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    run(d, { routeBlockMin: 30 }, []);
    t.mock.timers.tick(61_000);
    d.reportDeadRoute("EQUIPMENT", "X1-KG7-DD5E", undefined, "buy price now 2508c");
    t.mock.timers.tick(31 * MIN);
    run(d, { routeBlockMin: 30 });
    assert.equal(d.routeList()[0]!.buyAt, "X1-KG7-DD5E");
  });

  it("with the clause off, a report changes nothing", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    d.reportDeadRoute("EQUIPMENT", "X1-KG7-DD5E", undefined, "buy price now 2508c");
    run(d, { routeBlockMin: 0 });
    assert.equal(d.routeList()[0]!.buyAt, "X1-KG7-DD5E");
    assert.deepEqual(d.deadRouteList(), []);
    assert.equal(d.deadRouteReason("EQUIPMENT", "X1-KG7-DD5E", "X1-KG7-AA8B"), undefined);
  });
});

describe("a trader that finds the buy price gone tells the dispatcher", () => {
  function setup(reports: unknown[][]) {
    const ship = { symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-Q-B1", systemSymbol: "X1-Q" }, cargo: { capacity: 80, units: 0, inventory: [] }, fuel: { current: 100, capacity: 100 } } as unknown as Ship;
    const r = { good: "MEDICINE", buyAt: "X1-Q-B1", sellAt: "X1-Q-G58", buyPrice: 3_000, sellPrice: 4_200, margin: 1_200, volume: 40, lotSize: 20 };
    const api = {
      getCallCount: () => 0, getShip: async () => ship, getMyAgent: async () => ({ credits: 1_000_000 }),
      // the live ask has run up to 4,190c: a 10c margin, under any floor
      getMarket: async (_s: string, w: string) => ({ tradeGoods: [{ symbol: "MEDICINE", purchasePrice: w === r.buyAt ? 4_190 : 0, sellPrice: 4_200, tradeVolume: 20 }] }),
      purchaseCargo: async () => { throw new Error("must not buy"); },
    };
    const t = new TraderAgent(ship, { api: api as any, assignedRoute: () => undefined, getCredits: () => 1_000_000, getMarketSnapshots: async () => [], reportDeadRoute: (...a: unknown[]) => { reports.push(a); } });
    t.withWorld([{ symbol: "X1-Q-B1", x: 0, y: 0 }, { symbol: "X1-Q-G58", x: 10, y: 0 }]);
    (t as any).ensureDocked = async () => {};
    (t as any).findRoute = () => ((t as any).deadRoutes.has(`${r.good}@${r.buyAt}`) ? undefined : r);
    return t;
  }
  it("reports the good and the buy market, for every destination", async () => {
    const reports: unknown[][] = [];
    const t = setup(reports);
    await (t as any).runArbitrage(undefined);
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]!.slice(0, 3), ["MEDICINE", "X1-Q-B1", undefined]);
    assert.match(String(reports[0]![3]), /4190c/);
  });
});

describe("a trader already on its way re-plans when another ship reported the route", () => {
  it("whyNotViable names the shared report", () => {
    const ship = { symbol: "S-2", nav: { status: "DOCKED", waypointSymbol: "X1-Q-B1", systemSymbol: "X1-Q" }, cargo: { capacity: 80, units: 0, inventory: [] }, fuel: { current: 100, capacity: 100 } } as unknown as Ship;
    const api = { getCallCount: () => 0, getShip: async () => ship, getMyAgent: async () => ({ credits: 1_000_000 }) };
    const t = new TraderAgent(ship, { api: api as any, assignedRoute: () => undefined, getCredits: () => 1_000_000, getMarketSnapshots: async () => [], deadRouteReason: (g, b) => (g === "MEDICINE" && b === "X1-Q-B1" ? "buy price now 4190c (reported dead, 20 min left)" : undefined) });
    t.withWorld([{ symbol: "X1-Q-B1", x: 0, y: 0 }, { symbol: "X1-Q-G58", x: 10, y: 0 }]);
    const r = { good: "MEDICINE", buyAt: "X1-Q-B1", sellAt: "X1-Q-G58", buyPrice: 3_000, sellPrice: 4_200, margin: 1_200, volume: 40, lotSize: 20 };
    assert.match((t as any).whyNotViable(r), /^dead route MEDICINE@X1-Q-B1: buy price now 4190c/);
    assert.doesNotMatch((t as any).whyNotViable({ ...r, buyAt: "X1-Q-B2" }), /dead route/);
  });
});
