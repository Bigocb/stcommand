import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager } from "../src/engine/feed.js";

// Live 2026-10-07 (THEO, 10 drones on CE5D): clearing each off-target ore through sellCargo cost a ship read, a dock,
// a refused sale and a jettison, about two thirds of the shared call budget.
const drone = { symbol: "D-1", nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-F" }, fuel: { capacity: 80, current: 50 }, cargo: { capacity: 15, units: 5, inventory: [] } } as any;
const hold = { capacity: 15, units: 5, inventory: [{ symbol: "IRON_ORE", units: 2 }, { symbol: "ICE_WATER", units: 3 }] };

describe("mine feed junk", () => {
  it("dumps low-value junk in one call each and mines in the same step, without trying to sell", async () => {
    const calls: string[] = [];
    const fm = new FeedManager({
      api: { getShipCargo: async () => hold } as any,
      getShip: async () => drone,
      dumpJunk: async (_s: string, g: string, u: number) => { calls.push(`dump ${u} ${g}`); },
      sellCargo: async () => { calls.push("sell"); },
      jettisonCargo: async () => { calls.push("jettison"); },
      mineOnce: async () => { calls.push("mine"); return true; },
    } as any);
    await fm.start("X1-A-2", "IRON_ORE", { carrierTarget: 1, mine: true });
    const feed = (await fm.list())[0]!;
    await (fm as any).stepCarrier(feed, "D-1", { retryAt: 0 });
    assert.deepEqual(calls, ["dump 3 ICE_WATER", "mine"]);
  });

  it("falls back to the full clear for anything dumpJunk refuses, and waits to mine until the hold is clear", async () => {
    const calls: string[] = [];
    const fm = new FeedManager({
      api: { getShipCargo: async () => hold } as any,
      getShip: async () => drone,
      dumpJunk: async () => { throw new Error("worth too much"); },
      sellCargo: async (_s: string, g: string) => { calls.push(`sell ${g}`); },
      mineOnce: async () => { calls.push("mine"); return true; },
    } as any);
    await fm.start("X1-A-2", "IRON_ORE", { carrierTarget: 1, mine: true });
    const feed = (await fm.list())[0]!;
    await (fm as any).stepCarrier(feed, "D-1", { retryAt: 0 });
    assert.deepEqual(calls, ["sell ICE_WATER"]);
  });
});
