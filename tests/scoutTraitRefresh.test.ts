import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScoutAgent, type Ship } from "../src/engine/scout.js";

/**
 * Confirmed live 2026-10-02: THEO-1 (a scout) stood on X1-Y84-F39A and
 * X1-Y84-EZ7D — both fuel stations — at 5 and 4 fuel, logged "cannot refuel
 * ... no reachable market", and drifted on to 0/400. The atlas had cached
 * X1-Y84 trait-less (see GalaxyAtlas.refreshWaypointTraits()), so neither
 * waypoint read as a market. Tour agents already re-fetch traits on arrival;
 * scouts didn't.
 */

function makeShip(waypointSymbol: string, status: "DOCKED" | "IN_ORBIT", fuelCurrent: number): Ship {
  return {
    symbol: "SCOUT-1",
    nav: { status, waypointSymbol, systemSymbol: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")) },
    cargo: { capacity: 0, units: 0, inventory: [] },
    fuel: { current: fuelCurrent, capacity: 400 },
    mounts: [],
  } as unknown as Ship;
}

describe("ScoutAgent.tick: learning a newly entered system's markets", () => {
  it("re-fetches the system's waypoint traits once, not on every tick", async () => {
    const ship = makeShip("X1-Y84-C30X", "IN_ORBIT", 400);
    const refreshed: string[] = [];
    const agent = new ScoutAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      refreshSystemMarkets: async (sys) => { refreshed.push(sys); },
    });
    agent.withWorld([{ symbol: "X1-Y84-C30X", x: 0, y: 0 }] as any, []);
    agent.withCharted(["X1-Y84-C30X"]); // nothing left to chart

    await agent.tick();
    await agent.tick();

    assert.deepEqual(refreshed, ["X1-Y84"]);
  });

  it("keeps going when the re-fetch fails", async () => {
    const ship = makeShip("X1-Y84-C30X", "IN_ORBIT", 400);
    const logs: string[] = [];
    const agent = new ScoutAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
      refreshSystemMarkets: async () => { throw new Error("rate limited"); },
    });
    agent.withWorld([{ symbol: "X1-Y84-C30X", x: 0, y: 0 }] as any, []);
    agent.withCharted(["X1-Y84-C30X"]);

    await agent.tick();

    assert.ok(logs.some((l) => l.includes("waypoint re-fetch") && l.includes("rate limited")));
  });

  it("tops off on a market when the tank is under half, instead of only when leaving", async () => {
    const ship = makeShip("X1-Y84-F39A", "DOCKED", 100);
    let refuelled = 0;
    const agent = new ScoutAgent(ship, {
      api: {
        getShip: async () => ship,
        refuelShip: async () => {
          refuelled += 1;
          return { fuel: { current: 400, capacity: 400 }, transaction: { totalPrice: 120 } };
        },
      } as any,
      log: () => {},
    });
    agent.withWorld([{ symbol: "X1-Y84-F39A", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] }] as any, []);
    agent.withCharted(["X1-Y84-F39A"]);

    await agent.tick();

    assert.equal(refuelled, 1);
  });

  it("does not try to refuel away from a market", async () => {
    const ship = makeShip("X1-Y84-C30X", "IN_ORBIT", 100);
    let refuelled = 0;
    const agent = new ScoutAgent(ship, {
      api: {
        getShip: async () => ship,
        refuelShip: async () => { refuelled += 1; return { fuel: { current: 400, capacity: 400 }, transaction: { totalPrice: 0 } }; },
      } as any,
      log: () => {},
    });
    agent.withWorld([{ symbol: "X1-Y84-C30X", x: 0, y: 0 }] as any, []);
    agent.withCharted(["X1-Y84-C30X"]);

    await agent.tick();

    assert.equal(refuelled, 0);
  });
});
