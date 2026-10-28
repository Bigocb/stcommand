import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_TRADE_BUY_LIMIT, tripBuyBudget } from "../src/engine/tripBudget.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

describe("tripBuyBudget: how much cash one trade may use", () => {
  it("limits a trip to its share of the spendable cash (the GRAVITON case: 1.35M against 3.4M)", () => {
    const b = tripBuyBudget(3_400_000, { cashSharePct: 25, freeBelow: 300_000 });
    assert.equal(b.budget, 850_000);
    assert.match(b.reason, /25% of the 3,400,000c spendable/);
  });

  it("never limits a trip below the always-allowed amount, so a small wallet is not throttled", () => {
    assert.equal(tripBuyBudget(175_000, { cashSharePct: 25, freeBelow: 300_000 }).budget, Number.POSITIVE_INFINITY);
    assert.equal(tripBuyBudget(1_000_000, { cashSharePct: 10, freeBelow: 300_000 }).budget, 300_000, "10% would be 100k; the floor of 300k wins");
  });

  it("off (0%) or no cash known limits nothing: today's behaviour", () => {
    assert.equal(tripBuyBudget(5_000_000, NO_TRADE_BUY_LIMIT).budget, Number.POSITIVE_INFINITY);
    assert.equal(tripBuyBudget(0, { cashSharePct: 25, freeBelow: 300_000 }).budget, Number.POSITIVE_INFINITY);
  });

  it("a share of 100% is no limit", () => {
    assert.equal(tripBuyBudget(2_000_000, { cashSharePct: 100, freeBelow: 0 }).budget, Number.POSITIVE_INFINITY);
  });
});

/** The real TraderAgent.runArbitrage() with a fake API: 80u of a 4,000c good in lots of 20, a 1,000,000c wallet. */
function setup(policy?: { cashSharePct: number; freeBelow: number }) {
  const ship = {
    symbol: "S-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-Q-B1", systemSymbol: "X1-Q" },
    cargo: { capacity: 80, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
  const route = { good: "MEDICINE", buyAt: "X1-Q-B1", sellAt: "X1-Q-G58", buyPrice: 4_000, sellPrice: 6_000, margin: 2_000, volume: 80, lotSize: 20 };
  const purchases: number[] = [];
  const logs: string[] = [];
  const fires: string[] = [];
  let boughtUnits = 0;
  const api = {
    getCallCount: () => 0,
    getShip: async () => ship,
    getMyAgent: async () => ({ credits: 1_000_000 }),
    getMarket: async (_s: string, waypoint: string) => ({ tradeGoods: [{ symbol: "MEDICINE", purchasePrice: waypoint === route.buyAt ? 4_000 : 0, sellPrice: 6_000, tradeVolume: 20 }] }),
    purchaseCargo: async (_ship: string, _good: string, units: number) => {
      purchases.push(units);
      boughtUnits += units;
      return { cargo: { capacity: 80, units: boughtUnits, inventory: [{ symbol: "MEDICINE", units: boughtUnits }] }, transaction: { pricePerUnit: 4_000, totalPrice: 4_000 * units } };
    },
  };
  const t = new TraderAgent(ship, {
    api: api as any,
    assignedRoute: () => undefined,
    getCredits: () => 1_000_000,
    getMarketSnapshots: async () => [],
    log: (m: string) => logs.push(m),
    recordDoctrineFire: (k: string) => fires.push(k),
    ...(policy ? { tradeBuyPolicy: () => policy } : {}),
  } as never);
  t.withWorld([{ symbol: "X1-Q-B1", x: 0, y: 0 }, { symbol: "X1-Q-G58", x: 10, y: 0 }]);
  (t as any).ensureDocked = async () => {};
  (t as any).findRoute = () => ((t as any).deadRoutes.has(`${route.good}@${route.buyAt}`) ? undefined : route);
  return { t, purchases, logs, fires };
}

describe("the trip cash limit at the real buy loop", () => {
  it("stops buying when the trip has used its share (25% of 1,000,000c = 250,000c) and says so", async () => {
    const { t, purchases, logs, fires } = setup({ cashSharePct: 25, freeBelow: 0 });
    await (t as any).runArbitrage(undefined);
    const spent = purchases.reduce((a, b) => a + b, 0) * 4_000;
    assert.ok(spent <= 250_000, `spent ${spent}`);
    assert.ok(spent >= 240_000, "it still uses nearly all of its share");
    assert.match(logs.join("\n"), /stopping at \d+u MEDICINE: a trip may use 250,000c/);
    assert.deepEqual(fires, ["tradeBuyCashShare"]);
  });

  it("with the limit off the same trip buys the whole 80 units, as before", async () => {
    const { t, purchases, fires } = setup({ cashSharePct: 0, freeBelow: 0 });
    await (t as any).runArbitrage(undefined);
    assert.equal(purchases.reduce((a, b) => a + b, 0), 80);
    assert.deepEqual(fires, []);
  });

  it("with no policy supplied at all it behaves as before", async () => {
    const { t, purchases } = setup();
    await (t as any).runArbitrage(undefined);
    assert.equal(purchases.reduce((a, b) => a + b, 0), 80);
  });

  it("the always-allowed amount keeps a small trip whole: 320,000c is under the 400,000c floor", async () => {
    const { t, purchases } = setup({ cashSharePct: 10, freeBelow: 400_000 });
    await (t as any).runArbitrage(undefined);
    assert.equal(purchases.reduce((a, b) => a + b, 0), 80);
  });
});
