import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";

/**
 * Tour scouts pick their next market by distance, using the waypoint positions
 * seeded into the agent by withWorld(). That cache is filled once, when the
 * agent is constructed, from whatever the fleet knew at the time — which at
 * boot is the home system alone. A scout parked anywhere else therefore comes
 * back from a restart with no coordinates for the system it is standing in,
 * every candidate distance evaluates to Infinity, and it reports "no reachable
 * target" against a full target list forever without ever moving.
 */

function makeShip(waypointSymbol: string, systemSymbol: string): Ship {
  return {
    symbol: "TOUR-1",
    nav: { status: "IN_ORBIT", waypointSymbol, systemSymbol },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
  } as unknown as Ship;
}

/** A tour agent stranded in X1-REMOTE with only home-system positions cached. */
function makeStrandedTourAgent(opts: { ensureSystemCharted?: (sys: string) => Promise<void> } = {}) {
  const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
  const logs: string[] = [];
  const agent = new ShipAgent(ship, {
    api: { getShip: async () => ship } as any,
    log: (m) => logs.push(m),
    marketTourTargets: async () => ["X1-REMOTE-B2", "X1-REMOTE-C3"],
    ensureSystemCharted: opts.ensureSystemCharted,
  });
  // Seeded at construction with the home system only — nothing for X1-REMOTE.
  agent.withWorld([{ symbol: "X1-HOME-A1", x: 0, y: 0 }] as any, []);
  const navigated: string[] = [];
  (agent as any).refuelIfNeeded = async () => true;
  (agent as any).navigateTo = async (t: string) => { navigated.push(t); };
  (agent as any).ensureDocked = async () => {};
  return { agent, logs, navigated };
}

const remotePositions = [
  { symbol: "X1-REMOTE-A1", x: 0, y: 0 },
  { symbol: "X1-REMOTE-B2", x: 10, y: 0 },
  { symbol: "X1-REMOTE-C3", x: 40, y: 0 },
];

describe("ShipAgent.tourScout: repairing a position cache that predates the current system", () => {
  it("charts the system it is standing in when it has no position for it, then tours the nearest market", async () => {
    let chartedSystem: string | undefined;
    const { agent, navigated, logs } = makeStrandedTourAgent({
      ensureSystemCharted: async (sys) => {
        chartedSystem = sys;
        agent.withWorld(remotePositions as any, []);
      },
    });

    const worked = await (agent as any).tourScout();

    assert.equal(chartedSystem, "X1-REMOTE", "must chart the system the ship is actually in");
    assert.equal(worked, true);
    assert.deepEqual(navigated, ["X1-REMOTE-B2"], "nearest of the two now-visible markets");
    assert.ok(!logs.some((l) => l.includes("no reachable target")));
  });

  it("without the repair hook it strands itself: a full target list, nothing reachable, no movement", async () => {
    const { agent, navigated, logs } = makeStrandedTourAgent();

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false);
    assert.deepEqual(navigated, []);
    assert.ok(
      logs.some((l) => l.includes("no reachable target from X1-REMOTE-A1 (2 known)")),
      "reproduces the observed live symptom: known targets, none of them usable",
    );
  });

  it("ignores a same-named-distance market in another system", async () => {
    // Coordinates are per-system, so a waypoint in X1-HOME can sit "12 units"
    // from one in X1-REMOTE by pure coincidence. Flying there needs a jump, not
    // a navigate, so it must never be picked as a tour leg.
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    const logs: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
      marketTourTargets: async () => ["X1-HOME-B2"],
      ensureSystemCharted: async () => {
        agent.withWorld(
          [
            { symbol: "X1-REMOTE-A1", x: 0, y: 0 },
            { symbol: "X1-HOME-B2", x: 12, y: 0 }, // close by raw hypot, unreachable in fact
          ] as any,
          [],
        );
      },
    });
    const navigated: string[] = [];
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async (t: string) => { navigated.push(t); };
    (agent as any).ensureDocked = async () => {};

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false);
    assert.deepEqual(navigated, [], "a cross-system waypoint is not a navigable tour leg");
  });

  it("stands down instead of navigating when it cannot pay for the leg", async () => {
    // Live loop this reproduces: refuelIfNeeded() logged "stranded (0/300
    // fuel...)" and returned false, the navigate went ahead anyway and failed
    // with "requires 1 more fuel", and the whole sequence repeated every tick.
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 0, capacity: 300 });
    const logs: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
      marketTourTargets: async () => ["X1-REMOTE-B2"],
    });
    agent.withWorld(remotePositions as any, []);
    const navigated: string[] = [];
    (agent as any).refuelIfNeeded = async () => false; // no fuel, nowhere to buy it
    (agent as any).navigateTo = async (t: string) => { navigated.push(t); };
    (agent as any).ensureDocked = async () => {};

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false);
    assert.deepEqual(navigated, [], "must not attempt a leg it cannot fuel");
    assert.ok(logs.some((l) => l.includes("holding at X1-REMOTE-A1")));
  });

  it("never picks a refuel stop in another system", async () => {
    // Live loop this reproduces: a scout at X1-TP98-A14X was sent to refuel at
    // X1-KU72-I60, failing with "Destination X1-KU72-I60 is outside the
    // X1-TP98 system" once per tick.
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 27, capacity: 300 });
    const agent = new ShipAgent(ship, { api: { getShip: async () => ship } as any, log: () => {} });
    agent.withWorld(
      [
        { symbol: "X1-REMOTE-A1", x: 0, y: 0 },
        { symbol: "X1-HOME-I60", x: 5, y: 0 }, // 5 units away by raw hypot, a jump away in truth
      ] as any,
      [{ symbol: "X1-HOME-I60" }] as any,
    );

    assert.equal((agent as any).nearestReachableMarket(), undefined);
  });

  it("does not treat a market with no known position as zero distance away", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 27, capacity: 300 });
    const agent = new ShipAgent(ship, { api: { getShip: async () => ship } as any, log: () => {} });
    agent.withWorld(
      [{ symbol: "X1-REMOTE-A1", x: 0, y: 0 }] as any,
      [{ symbol: "X1-REMOTE-ZZ9" }] as any, // in-system market, but no coordinates
    );

    assert.equal(
      (agent as any).nearestReachableMarket(),
      undefined,
      "estimatedFuelTo() reports 0 for unknown waypoints; that must not read as nearest",
    );
  });

  it("refuels where it stands when the atlas says that waypoint is a market, even with no prices cached", async () => {
    // DAGGER-13 sat at X1-TP98-A14X — a FUEL_STATION — on 27/300 fuel logging
    // "stranded ... and no reachable market", because `markets` only lists
    // waypoints a snapshot exists for and nothing refreshes an agent's copy.
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 27, capacity: 300 });
    const agent = new ShipAgent(ship, {
      api: {
        getShip: async () => ship,
        refuelShip: async () => ({ fuel: { current: 300, capacity: 300 }, transaction: { totalPrice: 100 } }),
      } as any,
      log: () => {},
    });
    // The waypoint carries the MARKETPLACE trait but has no price snapshot —
    // the exact case that used to report a ship stranded on a fuel pump.
    // Seeded as a real trait so this exercises the production path rather
    // than an injected shortcut.
    agent.withWorld(
      remotePositions.map((w: any) => (w.symbol === "X1-REMOTE-A1" ? { ...w, traits: [{ symbol: "MARKETPLACE" }] } : w)) as any,
      [], // note: markets list is empty
    );
    let docked = false;
    (agent as any).ensureDocked = async () => { docked = true; };

    const ok = await (agent as any).refuelIfNeeded(5, "X1-REMOTE-C3");

    assert.equal(ok, true, "must refuel in place rather than report itself stranded");
    assert.equal(docked, true);
  });

  it("refuels out of a dead end when an empty tank is what made everything unreachable", async () => {
    // DAGGER-15 at 0/300 on X1-RD37-BB4D — itself a marketplace — returned at
    // "no reachable target" every tick and never reached refuelIfNeeded(),
    // because its range was what made every target unreachable.
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 0, capacity: 300 });
    const logs: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
      // Only a far target exists: unreachable on an empty tank, fine on a full one.
      marketTourTargets: async () => ["X1-REMOTE-FAR"],
    });
    agent.withWorld(
      [
        { symbol: "X1-REMOTE-A1", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
        { symbol: "X1-REMOTE-FAR", x: 900, y: 0 }, // beyond capacity, so no target is picked
      ] as any,
      [],
    );
    (agent as any).refuelIfNeeded = async () => {
      Object.assign(ship.fuel, { current: 300 }); // the pump works
      return true;
    };
    (agent as any).ensureDocked = async () => {};

    const worked = await (agent as any).tourScout();

    assert.equal(worked, true, "a successful top-up counts as progress");
    assert.ok(logs.some((l) => l.includes("refuelled at X1-REMOTE-A1 (0 → 300)")));
    assert.ok(!logs.some((l) => l.includes("no reachable target")));
  });

  it("does not spin when the market it is standing on sells no fuel", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 0, capacity: 300 });
    const logs: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: (m) => logs.push(m),
      marketTourTargets: async () => ["X1-REMOTE-FAR"],
    });
    agent.withWorld(
      [
        { symbol: "X1-REMOTE-A1", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
        { symbol: "X1-REMOTE-FAR", x: 900, y: 0 },
      ] as any,
      [],
    );
    (agent as any).refuelIfNeeded = async () => false; // market sells no fuel
    (agent as any).ensureDocked = async () => {};

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false, "no fuel gained means no progress; must not report work done");
    assert.ok(logs.some((l) => l.includes("no reachable target")));
  });

  it("reports an unmeasurable distance as Infinity, not zero", () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    const agent = new ShipAgent(ship, { api: { getShip: async () => ship } as any, log: () => {} });
    agent.withWorld([
      { symbol: "X1-REMOTE-A1", x: 0, y: 0 },
      { symbol: "X1-REMOTE-B2", x: 3, y: 4 },
    ] as any, []);

    // Known both ends: a real number.
    assert.equal((agent as any).estimatedFuelToBetween("X1-REMOTE-A1", "X1-REMOTE-A1"), 1);
    // Unknown destination: must not read as "zero fuel away", which is what
    // made the least-known candidates score best everywhere this is consumed.
    assert.equal((agent as any).estimatedFuelTo("X1-REMOTE-UNKNOWN"), Infinity);
    assert.equal((agent as any).estimatedFuelToBetween("X1-REMOTE-A1", "X1-NOPE-9"), Infinity);
    // With our own position known, distanceTo is an ordinary measurement.
    assert.equal((agent as any).distanceTo({ symbol: "X1-REMOTE-B2", x: 3, y: 4 }), 5);
    // Coordinates handed in are NOT trusted: the waypoint is resolved through
    // the registry, so a symbol it has never seen is unmeasurable no matter
    // what x/y the caller attaches to it. Every real caller now sources these
    // objects from the registry itself, and this is what stops a fabricated
    // pair of coordinates from ever becoming a flight decision.
    assert.equal((agent as any).distanceTo({ symbol: "X1-REMOTE-GHOST", x: 3, y: 4 }), Infinity);
    // Same reason, one step further: a waypoint in another system is
    // unmeasurable however close its raw coordinates happen to look.
    assert.equal((agent as any).distanceTo({ symbol: "X1-OTHER-B2", x: 3, y: 4 }), Infinity);

    // But not knowing where *we* are is not the same as everything being
    // adjacent: a ship whose own waypoint is uncharted must measure nothing,
    // or it picks an arbitrary target off a fabricated estimate.
    const lost = makeShip("X1-UNCHARTED-Q1", "X1-UNCHARTED");
    const lostAgent = new ShipAgent(lost, { api: { getShip: async () => lost } as any, log: () => {} });
    lostAgent.withWorld([{ symbol: "X1-REMOTE-A1", x: 0, y: 0 }] as any, []);
    assert.equal((lostAgent as any).distanceTo({ symbol: "X1-REMOTE-A1", x: 5, y: 5 }), Infinity);
  });

  it("records the market it is standing at before flying to the next one", async () => {
    // The leg that brought it here ended at navigateTo()'s NavigationPending,
    // so the ensureDocked()/recordMarket() after that navigate never ran. If
    // arrival isn't picked up at the top of the next tick, the scout tours
    // forever without ever recording a price — which is exactly what two
    // scouts did for seven and a half hours across two systems.
    const ship = makeShip("X1-REMOTE-B2", "X1-REMOTE");
    const recorded: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => ["X1-REMOTE-B2", "X1-REMOTE-C3"],
      recordMarket: async (wp) => { recorded.push(wp); },
    });
    agent.withWorld(remotePositions.map((w: any) => ({ ...w, traits: [{ symbol: "MARKETPLACE" }] })) as any, []);
    const navigated: string[] = [];
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async (t: string) => { navigated.push(t); };
    (agent as any).ensureDocked = async () => {};

    await (agent as any).tourScout();

    assert.deepEqual(recorded[0], "X1-REMOTE-B2", "the market it arrived at is recorded first");
    assert.deepEqual(navigated, ["X1-REMOTE-C3"], "then it moves on to the next one");
  });

  it("does not try to record a waypoint that is not a market", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    const recorded: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => ["X1-REMOTE-B2"],

      recordMarket: async (wp) => { recorded.push(wp); },
    });
    agent.withWorld(remotePositions as any, []);
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async () => {};
    (agent as any).ensureDocked = async () => {};

    await (agent as any).tourScout();

    assert.ok(
      !recorded.includes("X1-REMOTE-A1"),
      "no wasted getMarket call at the non-market we are standing on",
    );
  });

  it("does not re-chart when the current waypoint is already in the cache", async () => {
    let charts = 0;
    const { agent, navigated } = makeStrandedTourAgent({
      ensureSystemCharted: async () => { charts += 1; },
    });
    agent.withWorld(remotePositions as any, []);

    await (agent as any).tourScout();

    assert.equal(charts, 0, "positions already known — no reason to spend the API call");
    assert.deepEqual(navigated, ["X1-REMOTE-B2"]);
  });
});
