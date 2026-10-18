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
