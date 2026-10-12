import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager } from "../src/engine/feed.js";

// One shuttle collecting for several mine feeds into the same market (operator request, 2026-10-12).
function harness(opts: { cap?: number } = {}) {
  const suspended: string[] = [];
  const resumed: string[] = [];
  const sold: { good: string; units: number }[] = [];
  const dispatched: string[] = [];
  const holdReleases: string[] = [];
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
    releaseHold: async (s: string) => { holdReleases.push(s); },
  } as any);
  return { fm, col, suspended, resumed, sold, dispatched, holdReleases };
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

describe("a collector the operator had parked with a hold", () => {
  it("has the hold dropped once, so a flight to market is not undone by hold enforcement", async () => {
    const h = harness();
    await two(h);
    for (const g of ["IRON_ORE", "COPPER_ORE"]) await h.fm.setCollector("X1-A-H", g, { field: "X1-A-F", collector: "COL-1" }, true);
    const [a, b] = await h.fm.list();
    await (h.fm as any).stepCollector(a, [a, b]);
    await (h.fm as any).stepCollector(a, [a, b]);
    assert.deepEqual(h.holdReleases, ["COL-1"]);
  });
});

describe("a collector set without a field", () => {
  const withDrones = async (where: string[]) => {
    const pinned: string[] = [];
    const ships: Record<string, any> = Object.fromEntries(where.map((w, i) => [`D-${i}`, { symbol: `D-${i}`, nav: { status: "IN_ORBIT", waypointSymbol: w }, fuel: { capacity: 80, current: 80 }, cargo: { capacity: 15, units: 0, inventory: [] } }]));
    const fm = new FeedManager({
      api: {} as any,
      getShip: async (s: string) => ships[s],
      pickCarrier: async () => undefined,
      suspend: async () => {},
      resume: () => {},
      pinMiner: async (s: string, f: string) => { pinned.push(`${s}@${f}`); },
    } as any);
    await fm.start("X1-A-H", "IRON_ORE", { mine: true, carrierTarget: 0 });
    const f = (await fm.list())[0]!;
    (fm as any).active.get((fm as any).feedKey(f)).assignedShips = Object.keys(ships);
    return { fm, pinned };
  };

  it("takes the asteroid its drones are all at, so the drones really use the collector", async () => {
    const { fm, pinned } = await withDrones(["X1-A-F", "X1-A-F"]);
    await fm.setCollector("X1-A-H", "IRON_ORE", { collector: "COL-1" }, true);
    const f = (await fm.list())[0]!;
    assert.equal(f.field, "X1-A-F");
    assert.equal(f.collector, "COL-1");
    assert.deepEqual(pinned, ["D-0@X1-A-F", "D-1@X1-A-F"]);
  });

  it("is refused, and nothing is left half set, when the drones are not at one asteroid", async () => {
    const { fm } = await withDrones(["X1-A-F", "X1-A-G"]);
    await assert.rejects(fm.setCollector("X1-A-H", "IRON_ORE", { collector: "COL-1" }, true), /name the asteroid/);
    const f = (await fm.list())[0]!;
    assert.equal(f.collector, undefined);
  });
});
