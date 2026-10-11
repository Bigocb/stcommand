import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { logBuffer } from "../src/core/logBuffer.js";
import { ruleReasons } from "../src/engine/attention.js";
import type { Ship } from "../src/engine/trader.js";

const ship = (symbol: string, over: Partial<Ship> = {}): Ship => ({
  symbol, nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] },
  fuel: { current: 100, capacity: 100 }, ...over,
}) as unknown as Ship;
const agent = (symbol: string, s: Ship) => ({ symbol, getShip: () => s, isManual: () => false, isSuspended: () => false, isStranded: () => false, pinnedField: () => undefined, dispatchTo: async () => {}, resume: () => {}, suspend: () => {}, release: () => {} });
const fleetWith = (symbol: string) => {
  const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
  (fleet as any).tours.set(symbol, agent(symbol, ship(symbol)));
  return fleet;
};

describe("FleetManager: where a hold came from", () => {
  it("a hold replayed at boot is remembered as restored; a hold placed by a person is not", async () => {
    const fleet = fleetWith("TOUR-1");
    (fleet as any).restoringHold = true; // what init() sets around its replay
    await fleet.holdShip("TOUR-1");
    (fleet as any).restoringHold = false;
    assert.equal((fleet as any).restoredHolds.has("TOUR-1"), true);

    await fleet.holdShip("TOUR-1"); // a person holds it again, now
    assert.equal((fleet as any).restoredHolds.has("TOUR-1"), false, "a fresh hold is the operator's own");
  });

  it("releasing clears the marker", async () => {
    const fleet = fleetWith("TOUR-1");
    (fleet as any).restoringHold = true;
    await fleet.holdShip("TOUR-1");
    (fleet as any).restoringHold = false;
    await fleet.releaseShip("TOUR-1");
    assert.equal((fleet as any).restoredHolds.has("TOUR-1"), false);
  });
});

describe("FleetManager.attentionFacts", () => {
  it("reproduces the 2026-10-11 incident: a restored hold, and an approval line repeated", () => {
    const fleet = fleetWith("TOUR-1");
    (fleet as any).operatorHolds.set("TOUR-1", "X1-A-A1"); // the hold the fleet reports as "manual hold"
    (fleet as any).restoredHolds.add("TOUR-1");
    for (let i = 0; i < 20; i++) logBuffer.push("?", "TOUR-1: tour scout: holding at X1-A-A1 — keeper probe approval pending");

    const f = fleet.attentionFacts().find((x) => x.symbol === "TOUR-1")!;
    assert.equal(f.held, true);
    assert.equal(f.restoredHold, true);
    assert.equal(f.timesRepeated >= 20, true);
    assert.equal(f.waitingOnApproval, true);
    assert.ok(f.minutesSinceLastLogLine !== null && f.minutesSinceLastLogLine < 1);
    assert.deepEqual(ruleReasons(f).map((r) => r.code), ["restored_hold", "waiting_approval"]);
  });

  it("computes fuel and cargo as percentages in code, and an unlit tank as null", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).traders.set("T-1", agent("T-1", ship("T-1", { fuel: { current: 25, capacity: 100 }, cargo: { capacity: 40, units: 10, inventory: [] } } as Partial<Ship>)));
    (fleet as any).keepers.set("K-1", agent("K-1", ship("K-1", { fuel: { current: 0, capacity: 0 } } as Partial<Ship>)));
    const by = new Map(fleet.attentionFacts().map((f) => [f.symbol, f]));
    assert.equal(by.get("T-1")!.fuelPercent, 25);
    assert.equal(by.get("T-1")!.cargoPercent, 25);
    assert.equal(by.get("K-1")!.fuelPercent, null, "a probe has no tank, so it is never 'low on fuel'");
  });

  it("measures seconds past arrival for a ship still in transit", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    const arrival = new Date(Date.now() - 600_000).toISOString();
    (fleet as any).traders.set("T-2", agent("T-2", ship("T-2", { nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", route: { arrival, destination: { symbol: "X1-A-B2" } } } } as Partial<Ship>)));
    const f = fleet.attentionFacts().find((x) => x.symbol === "T-2")!;
    assert.ok(f.secondsPastArrival >= 599 && f.secondsPastArrival <= 603);
  });

  it("the feed stays empty and idle while its clause is off", async () => {
    const fleet = fleetWith("TOUR-1");
    const snap = await fleet.attention.refresh();
    assert.equal(snap.enabled, false);
    assert.deepEqual(snap.items, []);
  });
});
