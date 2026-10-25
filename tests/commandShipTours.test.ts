import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager, isStartingCommandShip } from "../src/engine/fleet.js";

/**
 * 2026-10-25: the new week's command ship (a frigate with a mining laser and a 40-unit hold) was derived as a miner, and mined
 * ore for over an hour that it could not sell well. The opening playbook has it tour until there are good routes.
 */
function ship(symbol: string, role = "COMMAND", mounts = ["MOUNT_MINING_LASER_I"]) {
  return {
    symbol,
    registration: { name: symbol, role },
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    frame: { symbol: "FRAME_FRIGATE" },
    mounts: mounts.map((symbol) => ({ symbol })),
  } as any;
}

function fleet() {
  return new FleetManager({ api: { onMarket: () => {} } as any });
}

describe("the starting command ship", () => {
  it("is recognised by role COMMAND and the -1 name", () => {
    assert.equal(isStartingCommandShip(ship("THEOREM-1")), true);
    assert.equal(isStartingCommandShip(ship("THEOREM-1B")), false, "a later hull is not it");
    assert.equal(isStartingCommandShip(ship("THEOREM-21")), false);
    assert.equal(isStartingCommandShip(ship("THEOREM-1", "EXCAVATOR")), false);
  });

  it("is given the tour role, not miner, even with a mining laser and a hold", async () => {
    const f = fleet();
    const s = ship("THEOREM-1");
    await (f as any).assignRole(s);
    assert.ok((f as any).tours.has("THEOREM-1"), "must be a tour ship");
    assert.ok(!(f as any).miners.has("THEOREM-1"), "must not be a miner");
  });

  it("leaves an ordinary mining ship a miner (control)", async () => {
    const f = fleet();
    await (f as any).assignRole(ship("THEOREM-5", "EXCAVATOR"));
    assert.ok((f as any).miners.has("THEOREM-5"));
    assert.ok(!(f as any).tours.has("THEOREM-5"));
  });

  it("the hull-shape guess agrees", () => {
    assert.equal((fleet() as any).guessDefaultRole(ship("THEOREM-1")), "tour");
    assert.equal((fleet() as any).guessDefaultRole(ship("THEOREM-5", "EXCAVATOR")), "miner");
  });
});
