import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScoutAgent, type Ship } from "../src/engine/scout.js";

/**
 * A scout picking its own current waypoint as the next chart target (the
 * nearest uncharted candidate, at distance 0) used to still run the full
 * refuelIfNeeded() round-trip budget before attempting to chart it — pricing
 * in a return trip to the nearest market that has nothing to do with a
 * target the ship is already standing on.
 *
 * Confirmed live: THEO-A arrived at X1-MV41-B11A (an uncharted asteroid, no
 * market of its own) with 92/300 fuel and held there for over 6 hours
 * straight — "not enough fuel for X1-MV41-B11A and no reachable market" —
 * because the budget included the 100+ fuel trip back to the system's one
 * distant fuel station.
 */

function makeShip(waypointSymbol: string, systemSymbol: string, fuelCurrent: number): Ship {
  return {
    symbol: "SCOUT-1",
    nav: { status: "IN_ORBIT", waypointSymbol, systemSymbol },
    cargo: { capacity: 0, units: 0, inventory: [] },
    fuel: { current: fuelCurrent, capacity: 300 },
    mounts: [],
  } as unknown as Ship;
}

describe("ScoutAgent.tick: charting the waypoint the ship is already standing on", () => {
  it("doesn't hold for fuel when the target is 0 distance away, even with a far-off nearest market", async () => {
    const ship = makeShip("X1-MV41-B11A", "X1-MV41", 92);
    const logs: string[] = [];
    let charted = false;
    const agent = new ScoutAgent(ship, {
      api: {
        getShip: async () => ship,
        chartShip: async () => {
          charted = true;
          return { waypoint: { symbol: "X1-MV41-B11A", type: "ASTEROID", traits: [] } };
        },
      } as any,
      log: (m) => logs.push(m),
    });
    agent.withWorld(
      [
        { symbol: "X1-MV41-B11A", x: 103, y: 310 },
        { symbol: "X1-MV41-AB5Z", x: 108, y: 206, traits: [{ symbol: "MARKETPLACE" }] },
      ] as any,
      [],
    );
    // Nothing pre-charted: B11A is the only uncharted waypoint, distance 0.

    const worked = await agent.tick();

    assert.equal(worked, true, "must actually attempt the chart, not hold for a fuel budget that doesn't apply");
    assert.equal(charted, true);
    assert.ok(!logs.some((l) => l.includes("holding at") && l.includes("not enough fuel")));
  });

  it("attempts the leg via navigateTo()'s own DRIFT fallback rather than holding, as long as fuel remains", async () => {
    // Confirmed live: THEO-A hit this same wall one step further along —
    // 92/300 fuel, a ~104-fuel CRUISE round trip to the only known market,
    // held indefinitely — even though DRIFT could likely have covered that
    // distance on a fraction of the fuel. refuelIfNeeded()'s refusal only
    // means "can't afford CRUISE"; it must not veto the leg outright.
    const ship = makeShip("X1-MV41-B11A", "X1-MV41", 92);
    const logs: string[] = [];
    let navigated: string | undefined;
    const agent = new ScoutAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
    });
    agent.withWorld(
      [
        { symbol: "X1-MV41-B11A", x: 103, y: 310 },
        { symbol: "X1-MV41-FAR", x: 200, y: 310 },
      ] as any,
      [],
    );
    agent.withCharted(["X1-MV41-B11A"]);
    (agent as any).navigateTo = async (t: string) => { navigated = t; };
    (agent as any).ensureInOrbit = async () => {};

    const worked = await agent.tick();

    assert.equal(navigated, "X1-MV41-FAR", "must hand off to navigateTo() instead of holding");
    assert.ok(!logs.some((l) => l.includes("holding at") && l.includes("not enough fuel")));
  });

  it("still holds when genuinely out of fuel", async () => {
    const ship = makeShip("X1-MV41-B11A", "X1-MV41", 0);
    const logs: string[] = [];
    let navigated = false;
    const agent = new ScoutAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
    });
    agent.withWorld(
      [
        { symbol: "X1-MV41-B11A", x: 103, y: 310 },
        { symbol: "X1-MV41-FAR", x: 200, y: 310 },
      ] as any,
      [],
    );
    agent.withCharted(["X1-MV41-B11A"]);
    (agent as any).navigateTo = async () => { navigated = true; };

    const worked = await agent.tick();

    assert.equal(navigated, false, "nothing to fly a leg with at 0 fuel");
    assert.equal(worked, false);
    assert.ok(logs.some((l) => l.includes("holding at") && l.includes("not enough fuel")));
  });
});
