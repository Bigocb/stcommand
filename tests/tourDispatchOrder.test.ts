import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { CooldownPending, Pending } from "../src/engine/agentStep.js";

/** Issue #46 (2026-11-18): a ship sent with dispatch_tour toured the system it was in instead of walking to its target. */

function rig(system: string) {
  const ship = { symbol: "T-1", nav: { status: "IN_ORBIT", waypointSymbol: `${system}-GATE`, systemSymbol: system }, fuel: { current: 100, capacity: 100 }, cargo: { units: 0, capacity: 80, inventory: [] } };
  const fleet: any = new FleetManager({ api: { onMarket: () => {}, getShip: async () => ship } as any });
  const calls: string[] = [];
  fleet.updateShipManualState = async (_s: string, patch: { tourDestination?: string | null }) => {
    calls.push(`dest=${patch.tourDestination ?? "null"}`);
    if (patch.tourDestination) fleet.tourDestinations.set("T-1", patch.tourDestination);
    else fleet.tourDestinations.delete("T-1");
  };
  fleet.roleOf = () => "trader";
  fleet.setShipRole = async (_s: string, role: string) => {
    // The tour agent's first tick runs inside setShipRole: it must already see the destination.
    calls.push(`role=${role} sees=${fleet.tourDestinations.get("T-1") ?? "none"}`);
  };
  fleet.findSystemPath = () => [system, "X1-B"];
  return { fleet, calls };
}

describe("dispatchTourShip saves the destination before the role change", () => {
  it("the role change (and its first tour tick) already sees the target", async () => {
    const { fleet, calls } = rig("X1-A");
    await fleet.dispatchTourShip("T-1", "X1-B");
    assert.deepEqual(calls, ["dest=X1-B", "role=tour sees=X1-B"]);
  });

  it("a ship already in the target clears any old destination and tours in place", async () => {
    const { fleet, calls } = rig("X1-B");
    fleet.tourDestinations.set("T-1", "X1-OLD");
    await fleet.dispatchTourShip("T-1", "X1-B");
    assert.deepEqual(calls, ["dest=null", "role=tour sees=none"]);
  });

  it("a ship already on the tour role keeps it (no role change)", async () => {
    const { fleet, calls } = rig("X1-A");
    fleet.roleOf = () => "tour";
    await fleet.dispatchTourShip("T-1", "X1-B");
    assert.deepEqual(calls, ["dest=X1-B"]);
  });
});

describe("advanceTourDispatch waits at the gate on a jump cooldown instead of touring the system it passes through", () => {
  function hopRig(rejection: Error) {
    const ship = { symbol: "T-1", nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-GATE", systemSymbol: "X1-A" }, fuel: { current: 100, capacity: 100 }, cargo: { units: 0, capacity: 80, inventory: [] }, modules: [] };
    const fleet: any = new FleetManager({ api: { onMarket: () => {}, getShip: async () => ship } as any });
    fleet.tourDestinations.set("T-1", "X1-C");
    fleet.warpHopChoice = async () => ({ method: "gate", reason: "no warp drive" });
    fleet.galaxy.jumpPath = () => ["X1-A", "X1-B", "X1-C"];
    fleet.galaxy.loadSystem = async () => {};
    fleet.galaxy.getSystem = () => ({ waypoints: [{ symbol: "X1-B-GATE", type: "JUMP_GATE" }] });
    fleet.galaxy.gateComplete = () => true;
    fleet.jumpShip = async () => { throw rejection; };
    return fleet;
  }

  it("a cooldown refusal becomes a CooldownPending (the scheduler resumes the ship at the gate)", async () => {
    const fleet = hopRig(new Error("Ship action is still on cooldown for 152 second(s)."));
    await assert.rejects(() => fleet.advanceTourDispatch("T-1"), (err: unknown) => err instanceof CooldownPending && err instanceof Pending);
    assert.equal(fleet.tourDestinations.get("T-1"), "X1-C", "the destination is kept");
  });

  it("any other failure still falls through to touring while waiting (returns false), as before", async () => {
    const fleet = hopRig(new Error("Failed to execute jump. Waypoint X1-B-GATE is not connected to the current location"));
    assert.equal(await fleet.advanceTourDispatch("T-1"), false);
  });
});
