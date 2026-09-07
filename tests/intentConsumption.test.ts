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
  it("is true only for a hold with nowhere to fly — every other fleet-driven goal is the ship's own job", () => {
    // repair, explore and tender all left this list at step 5: every role
    // flies these goals itself through the shared executor
    // (ShipProxy.runFleetDrivenGoal), so the controller proposes and never
    // touches the hull. drivenByFleet() now answers only "is there truly
    // nothing to do" — a hold WITH a waypoint is somewhere to fly, so it is
    // not driven-by-fleet either; only a hold with no waypoint is.
    assert.ok(!drivenByFleet({ kind: "repair", yard: "Y" }));
    assert.ok(!drivenByFleet({ kind: "tender", to: "S2", fuelUnits: 100, market: "X1-A-M1", strandedSymbol: "S2" }));
    assert.ok(!drivenByFleet({ kind: "explore", system: "X1-B", gate: "X1-B-GATE", remoteGate: "X1-A-GATE", markets: [] }));
    // A hold splits in step 4. With a waypoint it is an operator parking a
    // hull somewhere, and the ship flies itself there through the shared
    // executor — so it is the ship's own job, not a stand-down. Without one
    // it is the arbiter saying "nothing worth doing", where there is nowhere
    // to fly and standing down *is* executing it.
    assert.ok(drivenByFleet({ kind: "hold" }));
    assert.ok(!drivenByFleet({ kind: "hold", waypoint: "X1-A-A1" }));
    // These the agent carries out on its own task.
    assert.ok(!drivenByFleet({ kind: "trade" }));
    assert.ok(!drivenByFleet({ kind: "mine" }));
    assert.ok(!drivenByFleet({ kind: "tour" }));
    assert.ok(!drivenByFleet({ kind: "keep", waypoint: "M1" }));
  });

  it("explains itself in the operator's words, naming the target — only for the one goal that is still a stand-down", () => {
    // repair/tender/explore are the ship's own job now (runFleetDrivenGoal
    // flies them), so standDownReason() has nothing to say about them —
    // there is no standing down happening. Only a waypoint-less hold, and
    // ordinary work the agent runs itself, reach this function at all.
    assert.equal(standDownReason(intent({ kind: "tender", to: "X1-A-YARD", fuelUnits: 100, market: "X1-A-M1", strandedSymbol: "X1-A-YARD" })), undefined, "a tender is the ship's own job now, not a stand-down");
    assert.equal(standDownReason(intent({ kind: "repair", yard: "X1-A-YARD" })), undefined, "a repair is the ship's own job now, not a stand-down");
    assert.equal(standDownReason(intent({ kind: "trade" })), undefined, "a goal the agent can execute is not a stand-down");
    assert.equal(standDownReason(undefined), undefined, "no intent is not a stand-down either");
  });
});

describe("every ShipAgent entry point hands a fleet-driven goal to the executor, not just tick()", () => {
  // Regression coverage for the bug this fixes: `tick()` (the miner role)
  // intercepted repair/hold/explore/tender before falling through to its own
  // logic; surveyScout()/tourScout()/keeperPoll() — surveyor, tour, and
  // keeper duty, all on this same class — did not, and went straight to
  // standDownReason(), which says nothing about a hold WITH a waypoint (that
  // case is deliberately not a "stand down", it's the ship's own job — see
  // above). Those three ran their own role logic right through an operator's
  // hold. Confirmed live: DRAGOM-7 was placed under an operator hold at
  // X1-S84-C46 at 18:06:46 and was "tour scout: touring X1-S84-C47" three
  // minutes later, while the fleet log and dashboard both kept reporting
  // "manual hold ... want:hold X1-S84-C46" the whole time.
  //
  // The ship is placed exactly at the hold's waypoint so runHoldGoal's
  // "already parked" branch fires with no navigation call needed — the
  // point of this test is whether the goal was intercepted at all, not
  // whether the fly-to-waypoint mechanics work (that's runHoldGoal's own
  // test in shipProxy.test.ts).
  const heldIntent = intent({ kind: "hold", waypoint: "X1-A-A1" }, "operator");

  it("tick() (miner) hands off — the one entry point that already worked", async () => {
    let mined = false;
    const agent = new ShipAgent(makeShip(), {
      api: { getCallCount: () => 0, getShip: async () => makeShip() } as any,
      log: () => {},
      intentFor: () => heldIntent,
    });
    // mineAndRefine()/extractUntilFull() would be reached via ordinary tick()
    // logic; there's no cheap flag for "did tick() mine", so the contract we
    // actually care about is the return value runHoldGoal() gives for an
    // already-parked ship: no work, not a crash, not a mining attempt.
    assert.equal(await agent.tick(), false, "already parked: reports no work");
  });

  it("tourScout() hands off — this was the entry point that missed the fix", async () => {
    let toured = false;
    const agent = new ShipAgent(makeShip(), {
      api: { getCallCount: () => 0, getShip: async () => makeShip() } as any,
      log: () => {},
      intentFor: () => heldIntent,
      marketTourTargets: async () => { toured = true; return []; },
    });
    assert.equal(await agent.tourScout(), false, "already parked: reports no work");
    assert.equal(toured, false, "must not fall through to its own tour logic");
  });

  it("surveyScout() hands off", async () => {
    let surveyed = false;
    const agent = new ShipAgent(makeShip(), {
      api: { getCallCount: () => 0, getShip: async () => makeShip() } as any,
      log: () => {},
      intentFor: () => heldIntent,
    });
    // pickSurveyTarget() runs off registry state private to the class; the
    // externally-observable contract is the same no-work return.
    assert.equal(await agent.surveyScout(), false, "already parked: reports no work");
    void surveyed;
  });

  it("keeperPoll() hands off", async () => {
    let recorded = false;
    const agent = new ShipAgent(makeShip(), {
      api: { getCallCount: () => 0, getShip: async () => makeShip() } as any,
      log: () => {},
      intentFor: () => heldIntent,
      keeperMarket: () => "X1-A-M1",
      recordMarket: async () => { recorded = true; },
    });
    assert.equal(await (agent as any).keeperPoll(), false, "already parked: reports no work");
    assert.equal(recorded, false, "must not fall through to its own keeper snapshot logic");
  });
});

describe("every role stands down on a waypoint-less hold — the one goal that still means \"nothing to do\"", () => {
  const api = { getCallCount: () => 0, getShip: async () => makeShip() } as any;

  it("ScoutAgent refuses", async () => {
    const logs: string[] = [];
    const agent = new ScoutAgent(makeShip() as any, { api, log: (m: string) => logs.push(m), intentFor: () => intent({ kind: "hold" }) });
    assert.equal(await agent.tick(), false);
    assert.ok(logs.some((l) => l.includes("standing down")));
  });

  it("SiphonerAgent refuses", async () => {
    const logs: string[] = [];
    const agent = new SiphonerAgent(makeShip() as any, { api, log: (m: string) => logs.push(m), intentFor: () => intent({ kind: "hold" }) });
    assert.equal(await agent.tick(), false);
    assert.ok(logs.some((l) => l.includes("standing down")));
  });

  it("a placed hold is flown, not stood down on", async () => {
    // Step 4. The operator's hold used to be a private manualGoal the fleet
    // set while flying the hull itself; now it is an intent the ship
    // executes. A ship already parked at the hold waypoint reports no work
    // rather than success, so it gets the scheduler's idle backoff instead of
    // being re-polled as though it were mid-task.
    const logs: string[] = [];
    const agent = new SiphonerAgent(makeShip() as any, {
      api, log: (m: string) => logs.push(m),
      intentFor: () => intent({ kind: "hold", waypoint: "X1-A-A1" }, "operator"),
    });
    assert.equal(await agent.tick(), false, "already parked: nothing to do");
    assert.ok(!logs.some((l) => l.includes("standing down")), "it is executing the hold, not refusing it");
  });

  it("TraderAgent refuses", async () => {
    const logs: string[] = [];
    const agent = new TraderAgent(makeShip() as unknown as TraderShip, { api, log: (m: string) => logs.push(m), intentFor: () => intent({ kind: "hold" }) });
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

describe("autoExplore never re-tasks a ship that is already flying", () => {
  // exploringShips is in-memory, so a restart forgets every trip in flight,
  // and manual holds are cleared on the way back up. That left a ship mid-leg
  // looking idle: DAGGER-15 was eight minutes into a 76-minute drift to its
  // jump gate for X1-SR82 when a later pass paired it with X1-JA40 and
  // dispatched it again, overwriting the intent for the trip under way.
  const fleetWithGates = () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    const atlas = (fleet as any).galaxy;
    for (const sys of ["X1-A", "X1-B"]) {
      atlas.systems.set(sys, {
        symbol: sys,
        // The gate is a real waypoint (type JUMP_GATE), same as
        // fleetNonBlocking.test.ts's own fixture — autoExplore()'s remote-
        // gate lookup reads .waypoints for that type, matching how
        // trader.ts's cross-system routing and fleet.ts's own jumpShip()
        // path already do it.
        waypoints: [
          { symbol: `${sys}-A1`, systemSymbol: sys, x: 0, y: 0, type: "PLANET", orbitals: [], traits: [], isUnderConstruction: false },
          { symbol: `${sys}-GATE`, systemSymbol: sys, x: 10, y: 10, type: "JUMP_GATE", orbitals: [], traits: [], isUnderConstruction: false },
        ],
        jumpGates: [{ symbol: `${sys}-GATE`, connections: [sys === "X1-A" ? "X1-B-GATE" : "X1-A-GATE"] }],
        markets: [], shipyards: [],
      });
    }
    atlas.gateConstruction.set("X1-A-GATE", true);
    atlas.gateConstruction.set("X1-B-GATE", true);
    return fleet;
  };
  const scoutAt = (status: string) => {
    const s = makeShip("SCOUT-1");
    (s as any).nav = { ...s.nav, status };
    return { symbol: "SCOUT-1", getShip: () => s, isManual: () => false, isSuspended: () => false, isStranded: () => false };
  };

  it("skips an IN_TRANSIT scout", async () => {
    // exploreSystem() no longer exists — step 5 moved the trip onto the
    // scout's own executor, so "launched" is now "an explore intent was
    // proposed", not a fleet-driven method call.
    const fleet = fleetWithGates();
    (fleet as any).tours.set("SCOUT-1", scoutAt("IN_TRANSIT"));

    await (fleet as any).autoExplore();
    fleet.intents.commit();
    assert.equal(fleet.intents.current("SCOUT-1"), undefined, "a hull already flying must not have an explore intent written over its trip");
  });

  it("still picks up a scout sitting in orbit", async () => {
    const fleet = fleetWithGates();
    (fleet as any).tours.set("SCOUT-1", scoutAt("IN_ORBIT"));

    await (fleet as any).autoExplore();
    fleet.intents.commit();
    assert.equal(fleet.intents.current("SCOUT-1")?.goal.kind, "explore", "the ordinary case must keep working");
  });
});
