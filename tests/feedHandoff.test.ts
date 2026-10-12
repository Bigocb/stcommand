import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager } from "../src/engine/feed.js";

// A drone delivers once it holds `handoffUnits` of the feed's good (operator request, 2026-10-12).
function harness(opts: { held: number; capacity?: number; collectorHere?: boolean }) {
  const transfers: number[] = [];
  const mined: string[] = [];
  const dispatched: string[] = [];
  const cap = opts.capacity ?? 15;
  const drone: any = { symbol: "D-1", nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-F", systemSymbol: "X1-A" }, fuel: { capacity: 100, current: 100 },
    cargo: { capacity: cap, units: opts.held, inventory: opts.held ? [{ symbol: "IRON_ORE", units: opts.held }] : [] } };
  const col: any = { symbol: "C-1", nav: { status: "IN_ORBIT", waypointSymbol: opts.collectorHere === false ? "X1-A-H" : "X1-A-F", systemSymbol: "X1-A" }, fuel: { capacity: 100, current: 100 },
    cargo: { capacity: 80, units: 0, inventory: [] } };
  const fm = new FeedManager({
    api: { getShipCargo: async () => drone.cargo, dockShip: async () => {} } as any,
    getShip: async (s: string) => (s === "C-1" ? col : drone),
    orbitShip: async () => {},
    transferCargo: async (_f: string, _g: string, units: number) => { transfers.push(units); },
    mineOnce: async (s: string) => { mined.push(s); return true; },
    dispatchShip: async (_s: string, wp: string) => { dispatched.push(wp); },
    suspend: async () => {},
    pinMiner: async () => {},
    setMinerPreference: async () => {},
  } as any);
  return { fm, transfers, mined, dispatched };
}

async function run(opts: Parameters<typeof harness>[0], handoffUnits: number | undefined, collector = true) {
  const h = harness(opts);
  await h.fm.start("X1-A-H", "IRON_ORE", { mine: true, carrierTarget: 0 });
  await h.fm.setCollector("X1-A-H", "IRON_ORE", { field: "X1-A-F", collector: collector ? "C-1" : null, handoffUnits }, true);
  const feed = (await h.fm.list())[0]!;
  await (h.fm as any).stepCarrier(feed, "D-1", { retryAt: 0 });
  return h;
}

describe("feed handoffUnits", () => {
  it("hands over at the threshold even though the hold is not nearly full", async () => {
    const h = await run({ held: 10, capacity: 40 }, 10);
    assert.deepEqual(h.transfers, [10]);
  });
  it("without the setting the same drone keeps mining until its hold is nearly full", async () => {
    const h = await run({ held: 10, capacity: 40 }, undefined);
    assert.deepEqual(h.transfers, []);
    assert.deepEqual(h.mined, ["D-1"]);
  });
  it("below the threshold it keeps mining", async () => {
    const h = await run({ held: 9, capacity: 40 }, 10);
    assert.deepEqual(h.transfers, []);
    assert.deepEqual(h.mined, ["D-1"]);
  });
  it("with the collector away and room left it keeps mining instead of waiting", async () => {
    const h = await run({ held: 10, capacity: 40, collectorHere: false }, 10);
    assert.deepEqual(h.transfers, []);
    assert.deepEqual(h.mined, ["D-1"]);
  });
  it("with no collector the drone flies to market at the threshold instead of waiting for a full hold", async () => {
    const h = await run({ held: 10, capacity: 40 }, 10, false);
    assert.deepEqual(h.dispatched, ["X1-A-H"]);
    assert.deepEqual(h.mined, []);
    const idle = await run({ held: 10, capacity: 40 }, undefined, false);
    assert.deepEqual(idle.dispatched, [], "no setting: keeps mining");
  });
  it("validates the setting", async () => {
    const h = harness({ held: 0 });
    await h.fm.start("X1-A-H", "IRON_ORE", { mine: true, carrierTarget: 0 });
    await assert.rejects(h.fm.setCollector("X1-A-H", "IRON_ORE", { handoffUnits: 0 }, true), /1 to 200/);
    await h.fm.setCollector("X1-A-H", "IRON_ORE", { handoffUnits: 10 }, true);
    assert.equal((await h.fm.list())[0]!.handoffUnits, 10);
    await h.fm.setCollector("X1-A-H", "IRON_ORE", { handoffUnits: null }, true);
    assert.equal((await h.fm.list())[0]!.handoffUnits, undefined);
  });
});
