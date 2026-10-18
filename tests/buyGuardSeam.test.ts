import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * The buy guards at their real seam: the actual TraderAgent.runArbitrage() with a fake API, counting what it asked the
 * markets and what it bought. THEOREM-5's MEDICINE loop of 2026-10-18 is the shape: E52 -> G58, lots of 20, the ask
 * climbing lot over lot while the sink's bid sat below what the next lot needed.
 *
 * findRoute() is stubbed to hand back one route: the guard is what is under test, not route selection. The stub keeps
 * the real deadRoutes gate (viableRoute() refuses a route in that set) so a blocked route stops being offered.
 */
function setup(o: { ask: number; sink: number; asks?: number[]; guard?: number; volume?: number; lotSize?: number; sellPrice?: number }) {
  const volume = o.volume ?? 40;
  const lotSize = o.lotSize ?? 20;
  const askQueue = [...(o.asks ?? [o.ask])];
  const ship = {
    symbol: "S-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-Q-B1", systemSymbol: "X1-Q" },
    cargo: { capacity: 80, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
  const route = {
    good: "MEDICINE", buyAt: "X1-Q-B1", sellAt: "X1-Q-G58",
    buyPrice: o.ask, sellPrice: o.sellPrice ?? o.sink, margin: o.sink - o.ask,
    volume, lotSize,
  };
  const purchases: number[] = [];
  const marketReads: string[] = [];
  let boughtUnits = 0;
  const api = {
    getCallCount: () => 0,
    getShip: async () => ship,
    getMyAgent: async () => ({ credits: 1_000_000 }),
    getMarket: async (_system: string, waypoint: string) => {
      marketReads.push(waypoint);
      if (waypoint === route.buyAt) {
        const price = askQueue.length > 1 ? askQueue.shift()! : askQueue[0]!;
        return { tradeGoods: [{ symbol: "MEDICINE", purchasePrice: price, sellPrice: o.sink, tradeVolume: lotSize }] };
      }
      return { tradeGoods: [{ symbol: "MEDICINE", purchasePrice: 0, sellPrice: o.sink, tradeVolume: lotSize }] };
    },
    purchaseCargo: async (_ship: string, _good: string, units: number) => {
      const price = askQueue.length > 1 ? askQueue.shift()! : askQueue[0]!;
      purchases.push(units);
      boughtUnits += units;
      return {
        cargo: { capacity: 80, units: boughtUnits, inventory: [{ symbol: "MEDICINE", units: boughtUnits }] },
        transaction: { pricePerUnit: price, totalPrice: price * units },
      };
    },
  };
  const t = new TraderAgent(ship, {
    api: api as any,
    assignedRoute: () => undefined,
    getCredits: () => 1_000_000,
    getMarketSnapshots: async () => [],
    ...(o.guard !== undefined ? { buyGuardImpactPct: () => o.guard! } : {}),
  });
  t.withWorld([{ symbol: "X1-Q-B1", x: 0, y: 0 }, { symbol: "X1-Q-G58", x: 10, y: 0 }]);
  (t as any).ensureDocked = async () => {};
  (t as any).findRoute = () => ((t as any).deadRoutes.has(`${route.good}@${route.buyAt}`) ? undefined : route);
  return { t, purchases, marketReads };
}

describe("buy guard 1: the destination's live bid, read before the first lot", () => {
  it("refuses round three at the door (ask 4628, bid 4549) and buys nothing", async () => {
    const { t, purchases } = setup({ ask: 4_628, sink: 4_549, guard: 6 });
    await (t as any).runArbitrage(undefined);
    assert.equal(purchases.length, 0, "no lot may be bought into a sink that no longer clears the floor");
    assert.ok((t as any).sinkBlockedUntil.has("MEDICINE@X1-Q-B1"), "the route is blocked, not merely skipped this tick");
  });

  it("lets round one buy its two lots (ask 3409, bid 4213)", async () => {
    const { t, purchases } = setup({ ask: 3_409, sink: 4_213, asks: [3_409, 3_626], guard: 6 });
    await (t as any).runArbitrage(undefined);
    assert.deepEqual(purchases, [20, 20]);
  });

  it("does not repeat the block on the next tick", async () => {
    const { t, purchases, marketReads } = setup({ ask: 4_628, sink: 4_549, guard: 6 });
    await (t as any).runArbitrage(undefined);
    const readsAfterFirst = marketReads.length;
    await (t as any).runArbitrage(undefined);
    assert.equal(purchases.length, 0);
    assert.equal(marketReads.length, readsAfterFirst, "a blocked route must not be re-read every tick while it rests");
  });
});

describe("buy guard 2: stop between lots when the held lots have already eaten the sink's price", () => {
  it("buys the first lot and stops before the second (ask 3894 then 4223, bid 4300)", async () => {
    // The door clears at 4300 (margin 160c over two lots), but after lot one the next lot needs the sink to pay 4474c
    // to clear the floor once the 20 units already held are sold: it does not, so the trip carries 20 units, not 40.
    const { t, purchases } = setup({ ask: 3_894, sink: 4_300, asks: [3_894, 4_223], guard: 6 });
    await (t as any).runArbitrage(undefined);
    assert.deepEqual(purchases, [20], "exactly one lot: the second is stopped between lots");
    assert.equal((t as any).ship.cargo.units, 20, "the held cargo still goes to the sink");
    assert.equal((t as any).trips.size, 1, "the part-full hold is a planned trip, not a discarded buy");
  });
});

describe("both guards off: today's behaviour, unchanged", () => {
  it("buys into the same destination that the guard refuses", async () => {
    const { t, purchases } = setup({ ask: 4_628, sink: 4_549 });
    await (t as any).runArbitrage(undefined);
    // Today's path buys lot one and is then stopped by the OLD between-lot rule (planned sell 4549 minus the paid 4628 is
    // already under the floor) — one lot in, where the guard refuses the trip before any of it. That difference is the fix.
    assert.deepEqual(purchases, [20], "without the clause the old path still buys");
  });

  it("adds no market read of its own", async () => {
    // One read before the change: liveBuyPrice(). The guards add a second (the sink) only when the clause is on.
    const { t, marketReads } = setup({ ask: 3_409, sink: 4_213, asks: [3_409, 3_626] });
    await (t as any).runArbitrage(undefined);
    assert.deepEqual(marketReads, ["X1-Q-B1"]);
  });

  it("adds a sink read, and only that, when the clause is on", async () => {
    const { t, marketReads } = setup({ ask: 3_409, sink: 4_213, asks: [3_409, 3_626], guard: 6 });
    await (t as any).runArbitrage(undefined);
    assert.deepEqual(marketReads, ["X1-Q-B1", "X1-Q-G58"]);
  });
});

describe("the block survives the per-tick deadRoutes clear", () => {
  it("re-adds unexpired blocks after clearing, so the route is not re-read", () => {
    // Source-text check, in addition to the behaviour above: the clear site must carry the block across, or the ship
    // re-reads two markets and logs the same line every few seconds while the market recovers.
    const src = readFileSync(new URL("../src/engine/trader.ts", import.meta.url), "utf8");
    const clear = src.indexOf("for (const key of this.unreachableRoutes) this.deadRoutes.add(key);");
    assert.ok(clear > 0, "the per-tick clear is still there");
    const after = src.slice(clear, clear + 400);
    assert.match(after, /sinkBlockedUntil/, "the clear site must re-add the unexpired buy-guard blocks");
  });
});
