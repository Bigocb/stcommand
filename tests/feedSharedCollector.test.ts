import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager } from "../src/engine/feed.js";

// One shuttle collecting for several mine feeds into the same market (operator request, 2026-10-12).
function harness(opts: { cap?: number } = {}) {
  const suspended: string[] = [];
  const resumed: string[] = [];
  const sold: { good: string; units: number }[] = [];
  const dispatched: string[] = [];
  const col: any = {
    symbol: "COL-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-H" },
    fuel: { capacity: 100, current: 100 },
    cargo: { capacity: 80, units: 80, inventory: [{ symbol: "IRON_ORE", units: 50 }, { symbol: "COPPER_ORE", units: 30 }] },
  };
  const fm = new FeedManager({
    api: {
      getShipCargo: async () => col.cargo,
      dockShip: async () => {},
      sellCargo: async (_s: string, good: string, units: number) => {
        if (opts.cap && units > opts.cap) throw new Error(`Market transaction failed. Trade good ${good} has a limit of ${opts.cap} units per transaction.`);
        sold.push({ good, units });
        col.cargo.inventory = col.cargo.inventory.map((i: any) => (i.symbol === good ? { ...i, units: i.units - units } : i)).filter((i: any) => i.units > 0);
        col.cargo.units -= units;
        return { transaction: { pricePerUnit: 70, totalPrice: 70 * units } };
      },
    } as any,
    getShip: async () => col,
    suspend: async (s: string) => { suspended.push(s); },
    resume: (s: string) => { resumed.push(s); },
    dispatchShip: async (_s: string, wp: string) => { dispatched.push(wp); },
    pinMiner: async () => {},
  } as any);
  return { fm, col, suspended, resumed, sold, dispatched };
}

async function two(h: ReturnType<typeof harness>) {
  await h.fm.start("X1-A-H", "IRON_ORE", { mine: true, carrierTarget: 0 });
  await h.fm.start("X1-A-H", "COPPER_ORE", { mine: true, carrierTarget: 0 });
}

describe("one collector for several feeds", () => {
  it("is allowed when the feeds share the market and the field", async () => {
    const h = harness();
    await two(h);
    await h.fm.setCollector("X1-A-H", "IRON_ORE", { field: "X1-A-F", collector: "COL-1" }, true);
    await h.fm.setCollector("X1-A-H", "COPPER_ORE", { field: "X1-A-F", collector: "COL-1" }, true);
    const feeds = await h.fm.list();
    assert.deepEqual(feeds.map((f) => f.collector), ["COL-1", "COL-1"]);
  });

  it("is refused for a feed into a different market, or on a different field", async () => {
    const h = harness();
    await two(h);
    await h.fm.start("X1-A-K", "COPPER_ORE", { mine: true, carrierTarget: 0 });
    await h.fm.setCollector("X1-A-H", "IRON_ORE", { field: "X1-A-F", collector: "COL-1" }, true);
    await assert.rejects(h.fm.setCollector("X1-A-K", "COPPER_ORE", { field: "X1-A-F", collector: "COL-1" }, true), /same market/);
    await assert.rejects(h.fm.setCollector("X1-A-H", "COPPER_ORE", { field: "X1-A-G", collector: "COL-1" }, true), /same field/);
  });

  it("sells every good it carries when it reaches the market", async () => {
    const h = harness();
    await two(h);
    for (const g of ["IRON_ORE", "COPPER_ORE"]) await h.fm.setCollector("X1-A-H", g, { field: "X1-A-F", collector: "COL-1" }, true);
    const [a, b] = await h.fm.list();
    await (h.fm as any).stepCollector(a, [a, b]);
    assert.deepEqual(h.sold.map((s) => s.good).sort(), ["COPPER_ORE", "IRON_ORE"]);
    assert.equal(h.col.cargo.units, 0);
  });

  it("sells each good in chunks when the market caps a sale", async () => {
    const h = harness({ cap: 40 });
    await two(h);
    for (const g of ["IRON_ORE", "COPPER_ORE"]) await h.fm.setCollector("X1-A-H", g, { field: "X1-A-F", collector: "COL-1" }, true);
    const [a, b] = await h.fm.list();
    await (h.fm as any).stepCollector(a, [a, b]);
    assert.equal(h.sold.reduce((n, s) => n + s.units, 0), 80);
    assert.ok(h.sold.every((s) => s.units <= 40));
  });

  it("is released only when its last feed lets go", async () => {
    const h = harness();
    await two(h);
    for (const g of ["IRON_ORE", "COPPER_ORE"]) await h.fm.setCollector("X1-A-H", g, { field: "X1-A-F", collector: "COL-1" }, true);
    await h.fm.remove("X1-A-H", "IRON_ORE", true);
    assert.deepEqual(h.resumed, [], "still collecting for copper");
    await h.fm.remove("X1-A-H", "COPPER_ORE", true);
    assert.deepEqual(h.resumed, ["COL-1"]);
  });
});
