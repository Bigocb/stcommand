import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import type { Ship } from "../src/engine/trader.js";

/**
 * Two failures from the engine review, both confirmed live, both of which the
 * control-plane split is meant to make structurally impossible — but which are
 * fixed directly here because ships were burning down while the wider
 * refactor lands.
 */

function makeShip(symbol: string, over: Partial<Ship> = {}): Ship {
  return {
    symbol,
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 0, capacity: 300 },
    ...over,
  } as unknown as Ship;
}

const agentFor = (ship: Ship) => {
  let held = ship;
  return {
    symbol: ship.symbol,
    getShip: () => held,
    adoptShip: (next: Ship) => { held = next; },
    isManual: () => false,
    isSuspended: () => false,
    isStranded: () => false,
  };
};

/** Seed the fleet's registry with a system, marking some waypoints as markets. */
function seedWorld(fleet: FleetManager, marketWaypoints: string[] = []): void {
  const atlas = (fleet as any).galaxy;
  atlas.systems.set("X1-A", {
    symbol: "X1-A",
    waypoints: ["X1-A-A1", "X1-A-FUEL"].map((symbol, i) => ({
      symbol,
      systemSymbol: "X1-A",
      x: i * 10,
      y: 0,
      type: "PLANET",
      orbitals: [],
      traits: marketWaypoints.includes(symbol) ? [{ symbol: "MARKETPLACE", name: "M", description: "" }] : [],
      isUnderConstruction: false,
    })),
    jumpGates: [], markets: [], shipyards: [],
  });
}

describe("getStrandedShips covers every role that burns fuel", () => {
  it("sees a stranded tour, scout and siphoner, not only miners and traders", () => {
    // While this iterated miners and traders alone, three other roles could
    // strand with nothing able to notice — not the tender, not the bridge
    // triage, not the operator. DAGGER-13 and DAGGER-15 sat at 30/300 in orbit
    // for hours because a tour is neither a miner nor a trader.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedWorld(fleet);
    (fleet as any).tours.set("TOUR-1", agentFor(makeShip("TOUR-1")));
    (fleet as any).scouts.set("SCOUT-1", agentFor(makeShip("SCOUT-1")));
    (fleet as any).siphoners.set("SIPH-1", agentFor(makeShip("SIPH-1")));
    (fleet as any).surveyors.set("SURV-1", agentFor(makeShip("SURV-1")));

    const stranded = fleet.getStrandedShips().map((s) => s.symbol).sort();
    assert.deepEqual(stranded, ["SCOUT-1", "SIPH-1", "SURV-1", "TOUR-1"]);
  });

  it("still ignores a zero-tank hull, which cannot strand", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedWorld(fleet);
    (fleet as any).keepers.set("PROBE-1", agentFor(makeShip("PROBE-1", { fuel: { current: 0, capacity: 0 } } as any)));
    assert.deepEqual(fleet.getStrandedShips(), []);
  });

  it("does not call a ship stranded while it is standing on a fuel pump", () => {
    // The trait is the authority, not whether prices were ever recorded there.
    // A scout parked on an unsnapshotted fuel station used to report itself
    // stranded while sitting on the thing that would refuel it.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedWorld(fleet, ["X1-A-FUEL"]);
    (fleet as any).scouts.set("SCOUT-1", agentFor(makeShip("SCOUT-1", { nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-FUEL", systemSymbol: "X1-A" } } as any)));
    (fleet as any).scouts.set("SCOUT-2", agentFor(makeShip("SCOUT-2")));

    assert.deepEqual(fleet.getStrandedShips().map((s) => s.symbol), ["SCOUT-2"]);
  });
});

describe("repairShip decides from live state, not a stale cache", () => {
  it("re-fetches when the cached ship says IN_TRANSIT, instead of throwing", async () => {
    // The other half of the critical-repair loop. runCriticalRepair suspends
    // the agent and flies the ship itself, so the agent's cached snapshot
    // still says IN_TRANSIT long after arrival — nothing refreshed it. The
    // throw released the ship back to its role, which re-diverted it next
    // tick, forever. DAGGER-8 did this all day at condition 0.00.
    const staleCache = makeShip("DAGGER-8", { nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-YARD", systemSymbol: "X1-A" } } as any);
    const live = makeShip("DAGGER-8", { nav: { status: "DOCKED", waypointSymbol: "X1-A-YARD", systemSymbol: "X1-A" } } as any);

    let repaired = false;
    const fleet = new FleetManager({
      api: {
        getCallCount: () => 0,
        getShip: async () => live,
        getRepairCost: async () => ({ transaction: { totalPrice: 100 } }),
        getMyAgent: async () => ({ credits: 1_000_000 }),
        repairShip: async () => { repaired = true; return { transaction: { totalPrice: 100 } }; },
      } as any,
    });
    (fleet as any).tours.set("DAGGER-8", agentFor(staleCache));
    (fleet as any).isShipyard = async () => true;

    await fleet.repairShip("DAGGER-8");
    assert.equal(repaired, true, "a ship that has actually arrived and docked must be repairable");
  });

  it("still refuses when the ship genuinely is not docked at a yard", async () => {
    const inFlight = makeShip("DAGGER-9", { nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-YARD", systemSymbol: "X1-A" } } as any);
    const fleet = new FleetManager({
      api: { getCallCount: () => 0, getShip: async () => inFlight } as any,
    });
    (fleet as any).tours.set("DAGGER-9", agentFor(inFlight));
    (fleet as any).isShipyard = async () => true;

    await assert.rejects(() => fleet.repairShip("DAGGER-9"), /must be docked at a shipyard/);
  });
});

describe("a successful repair updates the snapshot the repair controller reads", () => {
  const damaged = (symbol: string) =>
    makeShip(symbol, {
      nav: { status: "DOCKED", waypointSymbol: "X1-A-YARD", systemSymbol: "X1-A" },
      frame: { condition: 0 }, engine: { condition: 1 }, reactor: { condition: 1 },
    } as any);

  it("hands the repaired ship back to its agent", async () => {
    // The live loop this closes: DAGGER-8 was genuinely repaired at 01:09:09
    // for 35,638c, and then re-diverted and re-repaired for 0c every ~13
    // seconds until 01:12:37. repairShip() never wrote the repaired ship
    // back, so maybeRepairFleet() — which decides from the agent's cached
    // snapshot — kept reading condition 0.00 and re-proposing the repair.
    const repaired = makeShip("DAGGER-8", {
      nav: { status: "DOCKED", waypointSymbol: "X1-A-YARD", systemSymbol: "X1-A" },
      frame: { condition: 1 }, engine: { condition: 1 }, reactor: { condition: 1 },
    } as any);

    const fleet = new FleetManager({
      api: {
        getCallCount: () => 0,
        getShip: async () => damaged("DAGGER-8"),
        getRepairCost: async () => ({ transaction: { totalPrice: 100 } }),
        getMyAgent: async () => ({ credits: 1_000_000 }),
        repairShip: async () => ({ ship: repaired, transaction: { totalPrice: 35638 } }),
      } as any,
    });
    const agent = agentFor(damaged("DAGGER-8"));
    (fleet as any).tours.set("DAGGER-8", agent);
    (fleet as any).isShipyard = async () => true;

    await fleet.repairShip("DAGGER-8");

    assert.equal((fleet as any).worstCondition(agent.getShip()), 1, "the controller must see the repaired condition, not the one it decided on");
  });

  it("leaves the snapshot alone when the API returns no ship", async () => {
    // Older recordings and any response shape without a ship must not blank
    // the agent's cache — a missing update is recoverable, a wrong one is not.
    const fleet = new FleetManager({
      api: {
        getCallCount: () => 0,
        getShip: async () => damaged("DAGGER-9"),
        getRepairCost: async () => ({ transaction: { totalPrice: 0 } }),
        getMyAgent: async () => ({ credits: 1_000_000 }),
        repairShip: async () => ({ transaction: { totalPrice: 0 } }),
      } as any,
    });
    const agent = agentFor(damaged("DAGGER-9"));
    (fleet as any).tours.set("DAGGER-9", agent);
    (fleet as any).isShipyard = async () => true;

    await fleet.repairShip("DAGGER-9");
    assert.equal(agent.getShip().symbol, "DAGGER-9", "still a ship, not undefined");
  });
});
