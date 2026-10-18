import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * THEOREM-64, 2026-10-18: 72u VIRAL_AGENTS (cost 31,127c, 15% allowed) sold in lots of 18 into X1-QD90-A1. Lot one fetched 27,294c; the market then
 * paid 20,428c for lot two, which went out because the guard only looked at the price lot one had fetched. Twice, 262k a pass.
 */
function setup(quotes: number[], fills: number[]) {
  const ship = { symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-Q-A1", systemSymbol: "X1-Q" }, cargo: { capacity: 80, units: 36, inventory: [{ symbol: "VIRAL_AGENTS", units: 36 }] }, fuel: { current: 100, capacity: 100 } } as unknown as Ship;
  const sold: number[] = []; let reads = 0;
  const t = new TraderAgent(ship, {
    api: {
      getCallCount: () => 0, getShip: async () => ship,
      getMarket: async () => ({ tradeGoods: [{ symbol: "VIRAL_AGENTS", purchasePrice: 99_999, sellPrice: quotes[Math.min(reads++, quotes.length - 1)], tradeVolume: 18 }] }),
      sellCargo: async (_s: string, _g: string, lot: number) => { const price = fills[sold.length]!; sold.push(lot); return { cargo: { capacity: 80, units: 36 - sold.reduce((a, b) => a + b, 0), inventory: [] }, transaction: { pricePerUnit: price, totalPrice: price * lot } }; },
    } as any,
    assignedRoute: () => undefined,
    getCredits: () => 1_000_000,
    getMarketSnapshots: async () => [],
  });
  t.withWorld([{ symbol: "X1-Q-A1", x: 0, y: 0 }]);
  (t as any).ensureDocked = async () => {};
  (t as any).heldCost.set("VIRAL_AGENTS", 31_127);
  (t as any).heldRoute.set("VIRAL_AGENTS", { good: "VIRAL_AGENTS", buyAt: "X1-Q-B1", sellAt: "X1-Q-A1", buyPrice: 31_127, sellPrice: 41_081, lotSize: 18 });
  return { t, sold };
}

describe("selling in lots: the next lot is judged by the market's price now", () => {
  it("stops after lot one when the market has already dropped below the floor", async () => {
    const { t, sold } = setup([27_294, 20_428], [27_294, 20_428]);   // the quote read before the sale, then the one after lot one
    await (t as any).deliverHeldCargo();
    assert.deepEqual(sold, [18], "lot two must not go out at 20,428c");
  });
  it("carries on when the market holds up", async () => {
    const { t, sold } = setup([30_000, 29_500], [30_000, 29_500]);
    await (t as any).deliverHeldCargo();
    assert.deepEqual(sold, [18, 18]);
  });
  it("with the market unreadable between lots, assumes the quarter drop and stops", async () => {
    const { t, sold } = setup([27_294], [27_294, 20_428]);
    (t as any).liveSellPrice = (() => { let n = 0; return async () => (n++ === 0 ? 27_294 : undefined); })();
    await (t as any).deliverHeldCargo();
    assert.deepEqual(sold, [18]);
  });
});

describe("a lot held below its floor", () => {
  function held(live: number) {
    const ship = { symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-Q-A1", systemSymbol: "X1-Q" }, cargo: { capacity: 80, units: 8, inventory: [{ symbol: "VIRAL_AGENTS", units: 8 }] }, fuel: { current: 100, capacity: 100 } } as unknown as Ship;
    let reads = 0, sold = 0; const asked: string[] = []; let answer: boolean | undefined;
    const t = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship,
        getMarket: async () => { reads++; return { tradeGoods: [{ symbol: "VIRAL_AGENTS", purchasePrice: 99_999, sellPrice: live, tradeVolume: 18 }] }; },
        sellCargo: async (_s: string, _g: string, lot: number) => { sold += lot; return { cargo: { capacity: 80, units: 0, inventory: [] }, transaction: { pricePerUnit: live, totalPrice: live * lot } }; } } as any,
      assignedRoute: () => undefined, getCredits: () => 1_000_000, getMarketSnapshots: async () => [],
      requestApproval: async (kind: string) => { asked.push(kind); return answer; },
    });
    t.withWorld([{ symbol: "X1-Q-A1", x: 0, y: 0 }]);
    (t as any).ensureDocked = async () => {};
    (t as any).redirectBelowFloor = async () => false;
    (t as any).heldCost.set("VIRAL_AGENTS", 31_127);
    (t as any).heldRoute.set("VIRAL_AGENTS", { good: "VIRAL_AGENTS", buyAt: "X1-Q-B1", sellAt: "X1-Q-A1", buyPrice: 31_127, sellPrice: 41_081, lotSize: 18 });
    return { t, reads: () => reads, sold: () => sold, asked, answer: (a: boolean | undefined) => { answer = a; } };
  }

  it("is not re-read every tick: the market is read once a minute while it is held", async () => {
    const h = held(11_975);
    await (h.t as any).deliverHeldCargo(); await (h.t as any).deliverHeldCargo(); await (h.t as any).deliverHeldCargo();
    assert.equal(h.reads(), 1, "three ticks, one market read");
    assert.equal(h.sold(), 0);
    (h.t as any).floorRecheckAt.set("VIRAL_AGENTS", 0);   // a minute later
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.reads(), 2);
  });

  it("asks the operator after five minutes, sells only when approved, and keeps holding on a denial", async () => {
    const h = held(11_975);
    await (h.t as any).deliverHeldCargo();
    assert.deepEqual(h.asked, [], "not before five minutes");
    (h.t as any).heldBelowFloorSince.set("VIRAL_AGENTS", Date.now() - 6 * 60_000); (h.t as any).floorRecheckAt.set("VIRAL_AGENTS", 0);
    h.answer(undefined); await (h.t as any).deliverHeldCargo();
    assert.deepEqual(h.asked, ["sellBelowFloor:S-1:VIRAL_AGENTS"]); assert.equal(h.sold(), 0, "still waiting");
    (h.t as any).floorRecheckAt.set("VIRAL_AGENTS", 0); h.answer(false); await (h.t as any).deliverHeldCargo();
    assert.equal(h.sold(), 0, "denied: held");
    (h.t as any).floorRecheckAt.set("VIRAL_AGENTS", 0); h.answer(true); await (h.t as any).deliverHeldCargo();
    assert.equal(h.sold(), 8, "approved: sold");
  });
});
