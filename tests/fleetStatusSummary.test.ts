import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import type { Ship } from "../src/engine/trader.js";

function makeShip(symbol: string, overrides: Partial<Ship> = {}): Ship {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
    ...overrides,
  } as unknown as Ship;
}

function makeAgent(symbol: string, ship: Ship, opts: { manual?: boolean; suspended?: boolean } = {}) {
  return {
    symbol,
    getShip: () => ship,
    isManual: () => !!opts.manual,
    isSuspended: () => !!opts.suspended,
    isStranded: () => false,
    pinnedField: () => undefined,
  };
}

describe("FleetManager.fleetStatusSummary", () => {
  it("reports a doing reason for every ship, including idle/cooldown/transit", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).miners.set("MINER-1", makeAgent("MINER-1", makeShip("MINER-1", { cooldown: { shipSymbol: "MINER-1", totalSeconds: 69, remainingSeconds: 30 } })));
    (fleet as any).traders.set("TRADER-1", makeAgent("TRADER-1", makeShip("TRADER-1", { nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", route: { destination: { symbol: "X1-A-B2" } } } as any })));
    (fleet as any).tours.set("TOUR-1", makeAgent("TOUR-1", makeShip("TOUR-1"), { manual: true }));
    (fleet as any).keepers.set("KEEP-1", makeAgent("KEEP-1", makeShip("KEEP-1"), { suspended: true }));

    const summary = fleet.fleetStatusSummary();
    const bySym = new Map(summary.map((s) => [s.symbol, s]));
    assert.equal(bySym.get("MINER-1")!.doing, "cooldown 30s");
    assert.equal(bySym.get("TRADER-1")!.doing, "transit → X1-A-B2");
    assert.equal(bySym.get("TOUR-1")!.doing, "manual hold");
    assert.equal(bySym.get("KEEP-1")!.doing, "suspended");
  });

  it("marks a stranded ship as stranded", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).traders.set("TRADER-1", makeAgent("TRADER-1", makeShip("TRADER-1", { fuel: { current: 0, capacity: 100 } })));
    // Force the trader to report stranded.
    (fleet as any).traders.get("TRADER-1").isStranded = () => true;
    const summary = fleet.fleetStatusSummary();
    assert.equal(summary.find((s) => s.symbol === "TRADER-1")!.doing, "stranded");
  });
});
