import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { ScoutAgent } from "../src/engine/scout.js";
import { SiphonerAgent } from "../src/engine/siphoner.js";
import { TraderAgent, type Ship as TraderShip } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";
import { drivenByFleet, standDownReason, type ShipIntent, DEFAULT_POLICY } from "../src/engine/intent.js";

/**
 * The second half of step 4: agents reading the board, not just controllers
 * writing to it.
 *
 * Until this, ownership was enforced only by suspend() — a parallel mechanism
 * whose ordering the agent never checked — which is how a repair diverter and
 * a tour agent ended up alternately flying the same hull every few seconds
 * for a day. An agent that stands down on the intent itself removes the race
 * rather than sequencing it.
 */

function makeShip(symbol = "SHIP-1"): Ship {
  return {
    symbol,
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
    cooldown: { remainingSeconds: 0 },
    mounts: [],
    modules: [],
  } as unknown as Ship;
}

const intent = (goal: ShipIntent["goal"], source = "repair"): ShipIntent => ({
  ship: "SHIP-1", version: 1, priority: 1, goal, policy: DEFAULT_POLICY,
  reason: "condition 0.00", source,
});

describe("drivenByFleet", () => {
  it("covers exactly the goals the fleet flies itself", () => {
    assert.ok(drivenByFleet({ kind: "repair", yard: "Y" }));
    assert.ok(drivenByFleet({ kind: "tender", to: "S2" }));
    assert.ok(drivenByFleet({ kind: "hold" }));
    // Exploration really is flown by the fleet today: autoExplore launches
    // exploreSystem, which jumps and tours the ship itself.
    assert.ok(drivenByFleet({ kind: "explore", system: "X1-B" }));
    // These the agent carries out on its own task.
    assert.ok(!drivenByFleet({ kind: "trade" }));
    assert.ok(!drivenByFleet({ kind: "mine" }));
    assert.ok(!drivenByFleet({ kind: "tour" }));
    assert.ok(!drivenByFleet({ kind: "keep", waypoint: "M1" }));
  });

  it("explains itself in the operator's words, naming the target", () => {
    assert.match(standDownReason(intent({ kind: "repair", yard: "X1-A-YARD" }))!, /repair → X1-A-YARD \(repair\): condition 0\.00/);
    assert.equal(standDownReason(intent({ kind: "trade" })), undefined, "a goal the agent can execute is not a stand-down");
    assert.equal(standDownReason(undefined), undefined, "no intent is not a stand-down either");
  });
});

describe("every role stands down when the fleet is driving its hull", () => {
  const api = { getCallCount: () => 0, getShip: async () => makeShip() } as any;

  it("ShipAgent tick, tour, survey and keeper all refuse to act", async () => {
    const logs: string[] = [];
    const agent = new ShipAgent(makeShip(), {
      api, log: (m) => logs.push(m),
      intentFor: () => intent({ kind: "repair", yard: "X1-A-YARD" }),
      keeperMarket: () => "X1-A-M1",
    });
    assert.equal(await agent.tick(), false);
    assert.equal(await agent.tourScout(), false);
    assert.equal(await agent.surveyScout(), false);
    assert.equal(await (agent as any).keeperPoll(), false);
    assert.equal(logs.filter((l) => l.includes("standing down")).length, 4, "each entry point refuses, not just one");
    assert.ok(logs[0]!.includes("condition 0.00"), "and says why, quoting the controller that decided");
  });

  it("ScoutAgent refuses", async () => {
    const logs: string[] = [];
    const agent = new ScoutAgent(makeShip() as any, { api, log: (m: string) => logs.push(m), intentFor: () => intent({ kind: "tender", to: "S2" }) });
    assert.equal(await agent.tick(), false);
    assert.ok(logs.some((l) => l.includes("standing down")));
  });

  it("SiphonerAgent refuses", async () => {
    const logs: string[] = [];
    const agent = new SiphonerAgent(makeShip() as any, { api, log: (m: string) => logs.push(m), intentFor: () => intent({ kind: "hold", waypoint: "X1-A-A1" }) });
    assert.equal(await agent.tick(), false);
    assert.ok(logs.some((l) => l.includes("standing down")));
  });

  it("TraderAgent refuses", async () => {
    const logs: string[] = [];
    const agent = new TraderAgent(makeShip() as unknown as TraderShip, { api, log: (m: string) => logs.push(m), intentFor: () => intent({ kind: "repair", yard: "Y" }) });
    assert.equal(await agent.tick(), false);
    assert.ok(logs.some((l) => l.includes("standing down")));
  });
});

describe("an agent still acts when the intent is its own work", () => {
  it("a trade or tour intent does not stand a ship down", async () => {
    let ticked = false;
    const agent = new ShipAgent(makeShip(), {
      api: { getCallCount: () => 0, getShip: async () => makeShip() } as any,
      log: () => {},
      intentFor: () => intent({ kind: "tour" }, "explore"),
      marketTourTargets: async () => { ticked = true; return []; },
    });
    await agent.tourScout();
    assert.equal(ticked, true, "a tour intent is the tour agent's own job");
  });

  it("no intent at all leaves behaviour exactly as before", async () => {
    let ticked = false;
    const agent = new ShipAgent(makeShip(), {
      api: { getCallCount: () => 0, getShip: async () => makeShip() } as any,
      log: () => {},
      marketTourTargets: async () => { ticked = true; return []; },
    });
    await agent.tourScout();
    assert.equal(ticked, true);
  });
});

describe("a fleet-driven intent is never left standing", () => {
  // The hazard this pairs with: because these goals stand an agent down, one
  // left committed after the fleet finishes would freeze the hull for good.
  const fleetWith = () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
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
    return fleet;
  };
  const agentFor = (ship: Ship) => ({ symbol: ship.symbol, getShip: () => ship, isManual: () => false, isSuspended: () => false, isStranded: () => false });

  it("releases the scout when an exploration trip succeeds", async () => {
    const fleet = fleetWith();
    (fleet as any).scouts.set("SCOUT-1", agentFor(makeShip("SCOUT-1")));
    (fleet as any).exploreSystem = async () => {};

    await (fleet as any).autoExplore();
    fleet.intents.commit();
    await new Promise((r) => setTimeout(r, 20)); // let the detached trip settle
    assert.equal(fleet.intents.current("SCOUT-1"), undefined, "an explore intent must not outlive the trip");
  });

  it("releases the scout even when the trip throws", async () => {
    const fleet = fleetWith();
    (fleet as any).scouts.set("SCOUT-1", agentFor(makeShip("SCOUT-1")));
    (fleet as any).exploreSystem = async () => { throw new Error("no jump gate"); };

    await (fleet as any).autoExplore();
    fleet.intents.commit();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fleet.intents.current("SCOUT-1"), undefined, "a failed trip must release the hull too, or it never moves again");
  });
});
