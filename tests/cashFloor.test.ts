import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * The cash floor is doctrine, and the trader spent straight through it.
 *
 * `cashFloor` is adopted by default, enabled, enforced, and says exactly
 * what it means: "the catch-all floor for every purchase (ships, modules,
 * repairs, cargo). Fuel is always exempt." fleet.ts's own comment on
 * spendableCredits() already named the hole — "several real spending paths
 * (a trader's own arbitrage/contract buying, repairShip(), a manual
 * dashboard buy) never checked it at all — a trader could spend the fleet to
 * zero on one big cargo buy with nothing stopping it."
 *
 * It did. Holding ~11,400c against a 20,000c floor, DRAGOM-1 bought 1u DRUGS
 * for 11,328c and was left with about a hundred credits — already under the
 * floor before the purchase, and under it by three orders of magnitude
 * after.
 *
 * The three purchase sites read `api.getMyAgent().credits` directly. That
 * live read is deliberate and has to stay: the fleet's cached balance is
 * refreshed once per tick and goes stale the moment another ship spends, so
 * swapping it for the cached-but-floored getCredits() would trade this bug
 * for that one. The fix keeps the live read and applies the floor to it.
 */

const FLOOR = 20_000;
const PRICE = 11_310;

function trader(credits: number, opts: { floored?: boolean } = {}) {
  const purchases: { good: string; units: number }[] = [];
  let traded = 0;
  const ship = {
    symbol: "DRAGOM-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-S84-H56", systemSymbol: "X1-S84", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  const agent = new TraderAgent(ship, {
    api: {
      getCallCount: () => 0,
      getShip: async () => ship,
      getMyAgent: async () => ({ credits }),
      purchaseCargo: async (_s: string, good: string, units: number) => {
        purchases.push({ good, units });
        return { cargo: ship.cargo, transaction: { pricePerUnit: PRICE, totalPrice: PRICE * units } };
      },
    },
    log: () => {},
    contractNeeded: async () => 100,
    // The wiring under test. Absent (the old behaviour) means no floor.
    ...(opts.floored === false ? {} : { applyCashFloor: (c: number) => Math.max(0, c - FLOOR) }),
  } as never);
  (agent as never as Record<string, unknown>).navigateTo = async () => {};
  (agent as never as Record<string, unknown>).ensureDocked = async () => {};
  (agent as never as Record<string, unknown>).liveBuyPrice = async () => PRICE;
  (agent as never as Record<string, unknown>).discoverPrices = async () => true;
  (agent as never as Record<string, unknown>).runArbitrage = async () => { traded += 1; return true; };
  return {
    purchases,
    counts: () => ({ traded }),
    runContractBuy: () =>
      (agent as never as { runContractBuy(a: unknown): Promise<boolean> }).runContractBuy({
        shipSymbol: "DRAGOM-1", good: "DRUGS", role: "contractBuy",
        buyAt: "X1-S84-H56", buyPrice: PRICE, source: "auto",
      }),
    spendableNow: () => (agent as never as { spendableNow(): Promise<number> }).spendableNow(),
  };
}

describe("spendableNow: live balance, floor applied", () => {
  it("subtracts the floor from the live balance", async () => {
    assert.equal(await trader(25_000).spendableNow(), 5_000);
  });

  it("never goes negative when the balance is already under the floor", async () => {
    assert.equal(await trader(11_400).spendableNow(), 0);
  });

  it("passes the balance straight through when no floor is wired", async () => {
    // Bare tests and any caller without a fleet behind it keep the old
    // behaviour rather than silently getting a floor of zero credits.
    assert.equal(await trader(25_000, { floored: false }).spendableNow(), 25_000);
  });
});

describe("a purchase respects the cash floor", () => {
  it("refuses a buy the floor cannot cover, even with the raw balance in hand", async () => {
    // 25,000c raw is two units affordable; 5,000c spendable is none. This is
    // the exact arithmetic the three sites were getting wrong.
    const t = trader(25_000);
    await t.runContractBuy();
    assert.deepEqual(t.purchases, [], "the raw balance is not the fleet's to spend");
    assert.equal(t.counts().traded, 1, "and it falls through to trading, as an unaffordable buy should");
  });

  it("reproduces the live case: under the floor already, buys nothing", async () => {
    const t = trader(11_400);
    await t.runContractBuy();
    assert.deepEqual(t.purchases, [], "this is the purchase that left the fleet with ~100c");
  });

  it("still buys when the floor genuinely leaves room", async () => {
    // The control: the floor must not become a blanket refusal.
    const t = trader(FLOOR + PRICE * 2);
    await t.runContractBuy();
    assert.equal(t.purchases.length, 1);
    assert.ok(t.purchases[0]!.units >= 1, "a fleet with headroom above the floor should trade normally");
  });
});
