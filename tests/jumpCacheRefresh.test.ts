import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * After a fleet-driven jump the ship's cached snapshot must show the new system. Before this, the dashboard table kept
 * showing the gate a ship had just left (THEOREM-86: table at X1-HR84-I60, live at X1-KK70-XB7D).
 */
const ship = (symbol: string, waypoint: string, system: string) => ({
  symbol,
  nav: { status: "IN_ORBIT", waypointSymbol: waypoint, systemSymbol: system },
  cargo: { capacity: 40, units: 0, inventory: [] },
  fuel: { current: 100, capacity: 100 },
}) as any;

describe("FleetManager cache refresh after a jump", () => {
  it("replaces the cached ship with the server's copy, so the table shows the new waypoint", async () => {
    const before = ship("T-86", "X1-HR84-I60", "X1-HR84");
    const after = ship("T-86", "X1-KK70-XB7D", "X1-KK70");
    const fleet = new FleetManager({ api: { getShip: async () => after } as any, log: () => {} });
    const f = fleet as any;
    let cached = before;
    f.traders.set("T-86", { getShip: () => cached, adoptShip: (next: any) => { cached = next; }, isManual: () => false, isSuspended: () => false, pinnedField: () => undefined });

    await f.refreshShipCache("T-86");

    assert.equal(fleet.currentShips()[0]!.nav.waypointSymbol, "X1-KK70-XB7D");
  });

  it("logs and carries on when the server can't be read, rather than failing the jump that already happened", async () => {
    const logged: string[] = [];
    const fleet = new FleetManager({ api: { getShip: async () => { throw new Error("503"); } } as any, log: (m: string) => logged.push(m) });

    await assert.doesNotReject(() => (fleet as any).refreshShipCache("T-86"));
    assert.match(logged.join("\n"), /T-86: cache refresh failed: 503/);
  });
});
