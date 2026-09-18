import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScoutAgent, type Ship } from "../src/engine/scout.js";

/**
 * ScoutAgent.dispatchTo() used to just set a flag and return immediately,
 * leaving the actual flight for some later scheduled tick to notice. Every
 * other role's dispatchTo() (ShipAgent, TraderAgent, SiphonerAgent) actually
 * flies there — and jumpShip()/dispatchShip() both assume that contract:
 * they call dispatchTo() to reach a jump gate, then immediately try the live
 * jump expecting the ship to already be there.
 *
 * Confirmed live: THEO-A (a scout) sat at X1-B48-F25A while the fleet
 * repeatedly logged "THEO-A jumping X1-B48-B13A -> X1-VJ42-X19E" followed by
 * "Failed to execute jump. Waypoint X1-B48-F25A is not a jump gate." on a
 * ~90s retry loop for over 15 minutes — dispatchTo(B13A) never actually flew
 * the ship there.
 */

function makeShip(waypointSymbol: string, systemSymbol: string): Ship {
  return {
    symbol: "SCOUT-1",
    nav: { status: "IN_ORBIT", waypointSymbol, systemSymbol },
    cargo: { capacity: 0, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
    mounts: [],
  } as unknown as Ship;
}

function makeScout() {
  const ship = makeShip("X1-B48-F25A", "X1-B48");
  const logs: string[] = [];
  const agent = new ScoutAgent(ship, {
    api: { getShip: async () => ship } as any,
    log: (m) => logs.push(m),
  });
  agent.withWorld(
    [
      { symbol: "X1-B48-F25A", x: 0, y: 0 },
      { symbol: "X1-B48-B13A", x: 50, y: 0 },
    ] as any,
    [],
  );
  const navigated: string[] = [];
  (agent as any).refuelIfNeeded = async () => true;
  (agent as any).navigateTo = async (t: string) => {
    navigated.push(t);
    ship.nav.waypointSymbol = t;
  };
  (agent as any).ensureInOrbit = async () => {};
  return { agent, logs, navigated };
}

describe("ScoutAgent.dispatchTo: actually flies there, like every other role's dispatchTo", () => {
  it("navigates to the target waypoint when not already there", async () => {
    const { agent, navigated } = makeScout();

    await agent.dispatchTo("X1-B48-B13A");

    assert.deepEqual(navigated, ["X1-B48-B13A"], "must actually fly to the gate, not just record it as a future goal");
    assert.equal(agent.getShip().nav.waypointSymbol, "X1-B48-B13A");
  });

  it("skips navigation when already at the target", async () => {
    const { agent, navigated } = makeScout();
    agent.getShip().nav.waypointSymbol = "X1-B48-B13A";

    await agent.dispatchTo("X1-B48-B13A");

    assert.deepEqual(navigated, []);
  });

  it("still records the manual goal, so a subsequent tick charts it", async () => {
    const { agent } = makeScout();

    await agent.dispatchTo("X1-B48-B13A");

    assert.equal(agent.isManual(), true);
  });
});
