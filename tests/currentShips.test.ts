import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * The dashboard's live snapshot is built from the ships the engine already
 * holds, not from re-listing every ship through the game API.
 */
const ship = (symbol: string, status = "DOCKED") => ({
  symbol,
  nav: { status, waypointSymbol: "X1-A-1", systemSymbol: "X1-A" },
  cargo: { capacity: 40, units: 0, inventory: [] },
  fuel: { current: 100, capacity: 100 },
}) as any;

const agentFor = (s: any) => ({ getShip: () => s, isManual: () => false, isSuspended: () => false, pinnedField: () => undefined });

describe("FleetManager.currentShips", () => {
  it("returns every ship the fleet drives, whichever role holds it, with no API calls", () => {
    let apiCalls = 0;
    const fleet = new FleetManager({ api: new Proxy({}, { get: () => () => { apiCalls += 1; } }) as any, log: () => {} });
    const f = fleet as any;
    f.miners.set("M-1", agentFor(ship("M-1", "IN_ORBIT")));
    f.traders.set("T-1", agentFor(ship("T-1", "IN_TRANSIT")));
    f.keepers.set("K-1", agentFor(ship("K-1")));
    f.idleShips.set("I-1", ship("I-1"));

    const symbols = fleet.currentShips().map((s) => s.symbol).sort();

    assert.deepEqual(symbols, ["I-1", "K-1", "M-1", "T-1"]);
    assert.equal(apiCalls, 0);
  });

  it("reflects what an agent has seen since, not a stale list", () => {
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    let current = ship("T-1", "IN_TRANSIT");
    (fleet as any).traders.set("T-1", { ...agentFor(null), getShip: () => current });
    assert.equal(fleet.currentShips()[0]!.nav.status, "IN_TRANSIT");
    current = ship("T-1", "DOCKED");
    assert.equal(fleet.currentShips()[0]!.nav.status, "DOCKED");
  });
});
