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
  const fleet = new FleetManager({ api, log: () => {} });
  // The galaxy lists X1-A-MARKET1 as a plain market (no SHIPYARD trait); every other waypoint is unlisted, so it reads as before.
  (fleet as any).galaxy = { getSystem: (sys: string) => (sys === "X1-A" ? { waypoints: [{ symbol: "X1-A-MARKET1", traits: [{ symbol: "MARKETPLACE" }] }, { symbol: "X1-A-Y1", traits: [{ symbol: "SHIPYARD" }] }] } : undefined) };
  return { fleet, calls };
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
  it("snapshots a yard once per thirty minutes however many ships dock there", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    for (let i = 0; i < 5; i += 1) await fleet.recordShipyardSnapshot("X1-A-Y1");
    assert.equal(calls.getShipyard, 1);
    await later(10 * 60_000, () => fleet.recordShipyardSnapshot("X1-A-Y1"));
    assert.equal(calls.getShipyard, 1);
    await later(31 * 60_000, () => fleet.recordShipyardSnapshot("X1-A-Y1"));
    assert.equal(calls.getShipyard, 2);
  });

  it("a fresh dock snapshot also serves the purchase check", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    await fleet.recordShipyardSnapshot("X1-A-Y1");
    await (fleet as any).cachedShipyard("X1-A", "X1-A-Y1");
    assert.equal(calls.getShipyard, 1);
  });
});

describe("buy-pass yard scans", () => {
  function fleetWithYards(shipsAt: string[]) {
    const { fleet, calls } = fleetCountingYardReads();
    const f = fleet as any;
    const yard = (symbol: string) => ({ symbol, type: "PLANET", x: 0, y: 0, traits: [{ symbol: "SHIPYARD" }] });
    f.galaxy = { listSystems: () => [{ symbol: "X1-A", waypoints: [yard("X1-A-Y1"), yard("X1-A-Y2"), yard("X1-A-Y3")] }] };
    f.cachedCredits = async () => 1_000_000;
    f.currentShips = () => shipsAt.map((wp, i) => ({ symbol: `S-${i}`, nav: { status: "DOCKED", waypointSymbol: wp } }));
    return { fleet, calls };
  }

  it("reads an unrecorded yard live only where one of our ships is, since other yards list no stock", async () => {
    const { fleet, calls } = fleetWithYards(["X1-A-Y2"]);
    await fleet.scanLoadouts();
    assert.equal(calls.getShipyard, 1);
  });

  it("reads none when no ship is at a yard", async () => {
    const { fleet, calls } = fleetWithYards([]);
    await fleet.scanLoadouts();
    assert.equal(calls.getShipyard, 0);
  });
});

describe("shipyard snapshot clock after a restart", () => {
  it("starts from the stored inventory's time, so a fresh process doesn't re-read a recently stored yard", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    const old = new Date(Date.now() - 40 * 60_000).toISOString();
    (fleet as any).store = {
      shipyardInventory: async () => [
        { waypointSymbol: "X1-A-Y1", timestamp: recent },
        { waypointSymbol: "X1-A-Y2", timestamp: old },
      ],
      recordShipyardInventory: async () => {},
    };
    await fleet.recordShipyardSnapshot("X1-A-Y1");
    assert.equal(calls.getShipyard, 0);
    await fleet.recordShipyardSnapshot("X1-A-Y2");
    assert.equal(calls.getShipyard, 1);
  });
});

describe("shipyard snapshots only for waypoints that have a shipyard", () => {
  it("doesn't call the API for a plain market a keeper polls", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    await fleet.recordShipyardSnapshot("X1-A-MARKET1");
    assert.equal(calls.getShipyard, 0);
    await fleet.recordShipyardSnapshot("X1-A-Y1");
    assert.equal(calls.getShipyard, 1);
  });

  it("reads as before when the system isn't loaded, so its traits are unknown", async () => {
    const { fleet, calls } = fleetCountingYardReads();
    (fleet as any).galaxy = { getSystem: () => undefined };
    await fleet.recordShipyardSnapshot("X1-A-MARKET1");
    assert.equal(calls.getShipyard, 1);
  });
});
