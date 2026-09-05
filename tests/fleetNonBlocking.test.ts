import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import type { Ship } from "../src/engine/trader.js";

/**
 * Finding 2 of the engine review: the coordinator tick blocked for entire
 * transits.
 *
 * autoExplore() awaited exploreSystem(), which jumps a ship to another system
 * and then tours its markets — minutes of real flight. FleetManager.run()
 * awaits tick() serially, so for that whole time nothing else in the fleet
 * ran: no dispatch recompute, no keeper assignment, no repair, no status sync.
 * The trip is now launched detached, the same shape runCriticalRepair()
 * already used.
 */

function makeShip(symbol: string, over: Partial<Ship> = {}): Ship {
  return {
    symbol,
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
    ...over,
  } as unknown as Ship;
}

const scoutAgent = (ship: Ship) => ({
  symbol: ship.symbol,
  getShip: () => ship,
  isManual: () => false,
  isSuspended: () => false,
  isStranded: () => false,
});

/** A galaxy with one reachable, unsurveyed neighbour. */
function seedGalaxy(fleet: FleetManager): void {
  const atlas = (fleet as any).galaxy;
  for (const sys of ["X1-A", "X1-B"]) {
    atlas.systems.set(sys, {
      symbol: sys,
      waypoints: [{ symbol: `${sys}-A1`, systemSymbol: sys, x: 0, y: 0, type: "PLANET", orbitals: [], traits: [], isUnderConstruction: false }],
      jumpGates: [{ symbol: `${sys}-GATE`, connections: [sys === "X1-A" ? "X1-B-GATE" : "X1-A-GATE"] }],
      markets: [], shipyards: [],
    });
  }
  atlas.gateConstruction.set("X1-A-GATE", true);
  atlas.gateConstruction.set("X1-B-GATE", true);
}

describe("autoExplore does not block the coordinator", () => {
  it("returns immediately even while the exploration trip is still flying", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedGalaxy(fleet);
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));

    let tripStarted = false;
    let releaseTrip: () => void = () => {};
    const trip = new Promise<void>((r) => { releaseTrip = r; });
    (fleet as any).exploreSystem = async () => { tripStarted = true; await trip; };

    const start = Date.now();
    await (fleet as any).autoExplore();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 500, `autoExplore must not wait for the trip (took ${elapsed}ms)`);
    assert.equal(tripStarted, true, "but the trip must actually have been launched");
    releaseTrip();
    await trip;
  });

  it("records who owns the scout and why, so a second subsystem cannot take it", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedGalaxy(fleet);
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));
    let release: () => void = () => {};
    const trip = new Promise<void>((r) => { release = r; });
    (fleet as any).exploreSystem = async () => { await trip; };

    await (fleet as any).autoExplore();
    fleet.intents.commit();

    const intent = fleet.intents.current("SCOUT-1");
    assert.equal(intent!.goal.kind, "explore");
    assert.equal(intent!.source, "explore");
    assert.ok(intent!.reason.includes("X1-B"), "the reason names the system, in the operator's words");
    release();
    await trip;
  });

  it("does not launch a second trip for a scout already exploring", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedGalaxy(fleet);
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));
    let launches = 0;
    let release: () => void = () => {};
    const trip = new Promise<void>((r) => { release = r; });
    (fleet as any).exploreSystem = async () => { launches += 1; await trip; };

    await (fleet as any).autoExplore();
    (fleet as any).lastExploreTick = 0; // let the throttle allow another pass
    await (fleet as any).autoExplore();

    assert.equal(launches, 1, "a scout already on a trip must not be dispatched again");
    release();
    await trip;
  });
});

describe("repair and explore no longer take turns driving the same hull", () => {
  it("a critical repair outranks an exploration already assigned", async () => {
    // The live failure: the repair diverter claimed the ship, the tour agent
    // kept flying it, and the two alternated every few seconds all day.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    fleet.intents.propose({ ship: "S1", priority: 3, goal: { kind: "explore", system: "X1-B" }, reason: "unsurveyed", source: "explore" });
    fleet.intents.commit();
    assert.equal(fleet.intents.current("S1")!.goal.kind, "explore");

    fleet.intents.propose({ ship: "S1", priority: 1, goal: { kind: "repair", yard: "X1-A-YARD" }, reason: "condition 0.00", source: "repair" });
    fleet.intents.commit();

    const intent = fleet.intents.current("S1")!;
    assert.equal(intent.goal.kind, "repair", "one owner, decided by priority");
    assert.equal(intent.version, 2, "and the change is visible as a new version");
  });
});
