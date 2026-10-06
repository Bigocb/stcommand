import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * Shipyard stock rotates slowly, yet the purchase checks re-read every yard on
 * every maintenance pass and every dock at a shipyard took a fresh snapshot.
 */

function fleetCountingYardReads() {
  const calls = { getShipyard: 0 };
  const api = {
    getShipyard: async (_s: string, symbol: string) => {
      calls.getShipyard += 1;
      return { symbol, ships: [], shipTypes: [] };
    },
  } as any;
  return { fleet: new FleetManager({ api, log: () => {} }), calls };
}

async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

describe("shipyard reads for purchase checks", () => {
  it("serves repeat checks from the cache", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    for (let i = 0; i < 10; i += 1) await (fleet as any).cachedShipyard("X1-A", "X1-A-Y1");
    assert.equal(calls.getShipyard, 1);
  });

  it("reads again once the cache is older than five minutes", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    await (fleet as any).cachedShipyard("X1-A", "X1-A-Y1");
    await later(6 * 60_000, () => (fleet as any).cachedShipyard("X1-A", "X1-A-Y1"));
    assert.equal(calls.getShipyard, 2);
  });

  it("keeps yards apart", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    await (fleet as any).cachedShipyard("X1-A", "X1-A-Y1");
    await (fleet as any).cachedShipyard("X1-A", "X1-A-Y2");
    assert.equal(calls.getShipyard, 2);
  });
});

describe("shipyard snapshots on dock", () => {
  it("snapshots a yard once per five minutes however many ships dock there", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    for (let i = 0; i < 5; i += 1) await fleet.recordShipyardSnapshot("X1-A-Y1");
    assert.equal(calls.getShipyard, 1);
    await later(6 * 60_000, () => fleet.recordShipyardSnapshot("X1-A-Y1"));
    assert.equal(calls.getShipyard, 2);
  });

  it("a fresh dock snapshot also serves the purchase check", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    await fleet.recordShipyardSnapshot("X1-A-Y1");
    await (fleet as any).cachedShipyard("X1-A", "X1-A-Y1");
    assert.equal(calls.getShipyard, 1);
  });
});
