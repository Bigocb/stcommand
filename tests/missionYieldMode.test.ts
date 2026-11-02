import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MissionManager } from "../src/engine/mission.js";

// Seam test for yield mode: the mission hands the carrier back to trading while every material is over its ceiling.
const cargoReads = { n: 0 };
function harness(quote: { price: number }, held: { symbol: string; units: number }[] = []) {
  const resumed: string[] = [];
  const ship: any = {
    symbol: "SHIP-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: held.reduce((n, h) => n + h.units, 0), inventory: held },
    fuel: { current: 100, capacity: 100 },
  };
  const api: any = {
    getConstruction: async () => ({ isComplete: false, materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }] }),
    getShipCargo: async () => { cargoReads.n += 1; return ship.cargo; },
    dockShip: async () => {},
    purchaseCargo: async () => { throw new Error("must not buy"); },
    supplyConstruction: async () => {},
  };
  const mgr = new MissionManager({
    api,
    getShip: async () => ship,
    listBuyers: async () => [{ waypoint: "X1-A-M1", purchasePrice: quote.price, tradeVolume: 20 }],
    getCredits: async () => 10_000_000,
    suspend: () => {},
    resume: (s: string) => { resumed.push(s); },
    pickCarrier: async () => "SHIP-1",
    dispatchShip: async () => {},
    canReach: async () => true,
    estimatedFuelBetween: () => 1,
  } as any);
  return { mgr, resumed, quote };
}

const MIN = 60_000;
afterEach(() => mock.timers.reset());

async function setup(price: number, pacing: Record<string, unknown>, held: { symbol: string; units: number }[] = []) {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const quote = { price };
  const h = harness(quote, held);
  await h.mgr.startConstruction("X1-A-I1");
  await h.mgr.assignCarrier("X1-A-I1", "SHIP-1");
  await h.mgr.setPacing("X1-A-I1", pacing as any);
  return h;
}
const crew = async (mgr: MissionManager) => (await mgr.list())[0]!.assignedShips;

describe("yield mode", () => {
  it("gives the carrier back once every material is over its ceiling and the hold has passed", async () => {
    const { mgr, resumed } = await setup(2500, { maxPrice: 2000, yieldToTrading: true });
    await mgr.tick();
    assert.deepEqual(await crew(mgr), ["SHIP-1"], "inside the minimum hold it stays");
    mock.timers.tick(11 * MIN);
    await mgr.tick();
    assert.deepEqual(await crew(mgr), []);
    assert.ok(resumed.includes("SHIP-1"));
    assert.equal(mgr.yieldStatus("X1-A-I1")?.decision, "yield");
    assert.match(mgr.yieldStatus("X1-A-I1")!.reason, /FAB_MATS 2,500 over 2,000/);
  });

  it("takes no ship again while the price stays over, even with a free trader offered", async () => {
    const { mgr } = await setup(2500, { maxPrice: 2000, yieldToTrading: true });
    await mgr.tick();
    mock.timers.tick(11 * MIN);
    await mgr.tick();
    mock.timers.tick(10 * MIN);
    await mgr.tick();
    assert.deepEqual(await crew(mgr), []);
  });

  it("takes the next free trader once the price falls to the ceiling, after the free time", async () => {
    const h = await setup(2500, { maxPrice: 2000, yieldToTrading: true });
    await h.mgr.tick();
    mock.timers.tick(11 * MIN);
    await h.mgr.tick();
    assert.deepEqual(await crew(h.mgr), []);
    h.quote.price = 1900;
    mock.timers.tick(1 * MIN);
    await h.mgr.tick();
    assert.deepEqual(await crew(h.mgr), [], "inside the 5 minute free time nothing is taken");
    mock.timers.tick(5 * MIN);
    await h.mgr.tick();
    assert.deepEqual(await crew(h.mgr), ["SHIP-1"]);
    assert.equal(h.mgr.yieldStatus("X1-A-I1")?.decision, "run");
  });

  it("never gives back a carrier that holds material the site still needs", async () => {
    const { mgr } = await setup(2500, { maxPrice: 2000, yieldToTrading: true }, [{ symbol: "FAB_MATS", units: 10 }]);
    await mgr.tick();
    mock.timers.tick(11 * MIN);
    await mgr.tick();
    assert.deepEqual(await crew(mgr), ["SHIP-1"]);
  });

  it("off behaves as before: the carrier stays and waits", async () => {
    const { mgr } = await setup(2500, { maxPrice: 2000 });
    await mgr.tick();
    mock.timers.tick(60 * MIN);
    await mgr.tick();
    assert.deepEqual(await crew(mgr), ["SHIP-1"]);
    assert.equal(mgr.yieldStatus("X1-A-I1"), undefined);
  });

  it("setPacing turns it on and off and reports it", async () => {
    const { mgr } = await setup(2500, {});
    assert.deepEqual(await mgr.setPacing("X1-A-I1", { yieldToTrading: true }), { yieldToTrading: true });
    assert.equal(await mgr.setPacing("X1-A-I1", { yieldToTrading: false }), null);
  });
});

describe("yield mode cost", () => {
  async function readsOver20s(pacing: Record<string, unknown>): Promise<number> {
    const { mgr } = await setup(2500, pacing, [{ symbol: "FAB_MATS", units: 10 }]);
    await mgr.tick();
    mock.timers.tick(11 * MIN);
    cargoReads.n = 0;
    for (let i = 0; i < 10; i++) { await mgr.tick(); mock.timers.tick(2_000); }
    const n = cargoReads.n;
    mock.timers.reset();
    return n;
  }
  it("looks in a loaded carrier's hold at most once more a minute than without the mode", async () => {
    const off = await readsOver20s({ maxPrice: 2000 });
    const on = await readsOver20s({ maxPrice: 2000, yieldToTrading: true });
    assert.ok(on - off <= 1, `yield mode added ${on - off} hold reads in 20 s (off ${off}, on ${on})`);
  });
});
