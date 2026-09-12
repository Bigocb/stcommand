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
    let docked = false;
    const agent = new ShipAgent(ship, {
      api: {
        getShip: async () => ship,
        // Docking is observed through the API rather than by stubbing an
        // agent method: refuelling lives in the shared ShipProxy now, so a
        // stub on the agent would not be on the path being exercised.
        dockShip: async () => { docked = true; Object.assign(ship.nav, { status: "DOCKED" }); return {}; },
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
    const ok = await (agent as any).refuelIfNeeded(5, "X1-REMOTE-C3");

    assert.equal(ok, true, "must refuel in place rather than report itself stranded");
    assert.equal(docked, true);
  });

  it("refuels out of a dead end when an empty tank is what made everything unreachable", async () => {
    // DAGGER-15 at 0/300 on X1-RD37-BB4D — itself a marketplace — returned at
    // "no reachable target" every tick and never reached refuelIfNeeded(),
    // because its range was what made every target unreachable.
    //
    // The docking-block top-off added for "buy fuel at every opportunity"
    // (see that test's own describe block below) now reaches this ship
    // first, in the same tick, before target-selection ever runs — so by
    // the time this scenario's own dead-end check would fire, the tank is
    // already full. FAR is still genuinely out of range at full capacity
    // (900 one-way vs. a 300 tank), so "no reachable target" is the
    // correct outcome here now; what still matters is that the ship
    // actually got refueled rather than looping at 0 forever.
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
        { symbol: "X1-REMOTE-FAR", x: 900, y: 0 }, // beyond capacity outright, refuel or not
      ] as any,
      [],
    );
    (agent as any).refuelIfNeeded = async () => {
      Object.assign(ship.fuel, { current: 300 }); // the pump works
      return true;
    };
    (agent as any).ensureDocked = async () => {};

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false, "genuinely nowhere reachable even at full capacity");
    assert.equal(ship.fuel.current, 300, "refueled by the opportunistic top-off, not left at 0");
    assert.ok(logs.some((l) => l.includes("no reachable target")));
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

describe("ShipAgent.tourScout: shipyard inventory on arrival, the market fix's own open gap closed", () => {
  // 26e8ac1 fixed the market half of this exact bug (a tour that never
  // records anything, because navigateTo() raises NavigationPending the
  // instant the ship enters transit and unwinds the method before the
  // recordMarket()/recordShipyard() at its foot ever run) and, in its own
  // commit message, flagged the shipyard half as the identical gap, left
  // open. It stayed open: a tour ship arriving at a shipyard-market kept its
  // price snapshot fresh and its ship-stock snapshot never updated, for the
  // same reason prices never used to update.
  it("records ship stock on arrival at a shipyard-market, not just prices", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    const marketsRecorded: string[] = [];
    const shipyardsRecorded: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      // No other target: the only listed waypoint is the one we are already
      // standing on, so `t !== here` filters it out of the reachable set and
      // the method returns "no reachable target" right after the arrival
      // block — keeping this test to exactly the arrival-recording behavior,
      // not target selection (covered by the rest of this file).
      marketTourTargets: async () => [],
      shipyardTourTargets: async () => ["X1-REMOTE-A1"], // standing here IS a shipyard
      recordMarket: async (wp) => { marketsRecorded.push(wp); },
      recordShipyard: async (wp) => { shipyardsRecorded.push(wp); },
    });
    agent.withWorld(remotePositions.map((w: any) => ({ ...w, traits: [{ symbol: "MARKETPLACE" }, { symbol: "SHIPYARD" }] })) as any, []);
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async () => { throw new Error("must not navigate — nothing else is reachable"); };
    (agent as any).ensureDocked = async () => {};

    await (agent as any).tourScout();

    assert.deepEqual(marketsRecorded, ["X1-REMOTE-A1"], "market snapshot on arrival — unchanged");
    assert.deepEqual(shipyardsRecorded, ["X1-REMOTE-A1"], "BUG (pre-fix): always empty — shipyard stock never refreshed on arrival");
  });

  it("does not scan for ship stock at an arrival waypoint that isn't a shipyard", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    const shipyardsRecorded: string[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => [],
      shipyardTourTargets: async () => [], // standing here is NOT a shipyard (and nothing else to tour)
      recordMarket: async () => {},
      recordShipyard: async (wp) => { shipyardsRecorded.push(wp); },
    });
    agent.withWorld(remotePositions.map((w: any) => ({ ...w, traits: [{ symbol: "MARKETPLACE" }] })) as any, []);
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).navigateTo = async () => { throw new Error("must not navigate — nothing else is reachable"); };
    (agent as any).ensureDocked = async () => {};

    await (agent as any).tourScout();

    assert.deepEqual(shipyardsRecorded, [], "a plain market must not get a spurious shipyard scan");
  });
});

describe("ShipAgent.tourScout: marks itself stranded, not just idle", () => {
  // Confirmed live: two of DRAGOM's four tour ships sat parked for 20+
  // minutes at a market with no FUEL good for sale, both real in-system fuel
  // stations far out of range on the ~10% tank they had left. getStrandedShips()
  // never saw either one — its zero-fuel fallback only catches exactly 0, and
  // nothing set the self-flagged stranded check this class now provides.
  it("marks stranded when critically low on fuel with nothing reachable and no fuel gained here", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 25, capacity: 300 }); // well under the 10% floor
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => ["X1-REMOTE-B2"],
    });
    agent.withWorld(
      [{ symbol: "X1-REMOTE-A1", x: 0, y: 0 }, { symbol: "X1-REMOTE-B2", x: 900, y: 0 }].map(
        (w) => ({ ...w, traits: [{ symbol: "MARKETPLACE" }] }),
      ) as any,
      [],
    );
    (agent as any).refuelIfNeeded = async () => true; // present, but gains nothing — no FUEL sold here
    (agent as any).atMarketHere = () => true;
    (agent as any).ensureDocked = async () => {};

    const worked = await (agent as any).tourScout();

    assert.equal(worked, false);
    assert.equal(agent.isStranded(), true, "flagged so getStrandedShips() can find it");
  });

  it("does not mark stranded when fuel is merely low, not critical", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 100, capacity: 300 }); // low, but above the 10% floor
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => ["X1-REMOTE-B2"],
    });
    agent.withWorld(
      [{ symbol: "X1-REMOTE-A1", x: 0, y: 0 }, { symbol: "X1-REMOTE-B2", x: 900, y: 0 }].map(
        (w) => ({ ...w, traits: [{ symbol: "MARKETPLACE" }] }),
      ) as any,
      [],
    );
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).atMarketHere = () => true;
    (agent as any).ensureDocked = async () => {};

    await (agent as any).tourScout();

    assert.equal(agent.isStranded(), false, "not every 'no reachable target' tick means genuinely marooned");
  });

  it("clears the stranded flag once a target becomes reachable again", async () => {
    // Reachability is judged against fuel CAPACITY (a full tank), not
    // current fuel — refuelIfNeeded() is what's supposed to cover the gap
    // to current — so a ship stranded this way only recovers once
    // something is actually within its tank's reach, not from simply
    // topping off toward a target its capacity could never make anyway.
    // Modeled here as a market opening up nearby (a tender relocating it,
    // or a genuinely new stop), same as DRAGOM-C's real fix would need.
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 25, capacity: 300 });
    let targets = ["X1-REMOTE-FAR"];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => targets,
    });
    agent.withWorld(
      [
        { symbol: "X1-REMOTE-A1", x: 0, y: 0 },
        { symbol: "X1-REMOTE-FAR", x: 900, y: 0 }, // round trip (1800) exceeds the 300 tank outright
        { symbol: "X1-REMOTE-NEAR", x: 50, y: 0 }, // round trip (100) well within it
      ].map((w) => ({ ...w, traits: [{ symbol: "MARKETPLACE" }] })) as any,
      [],
    );
    (agent as any).refuelIfNeeded = async () => true;
    (agent as any).atMarketHere = () => true;
    (agent as any).ensureDocked = async () => {};
    await (agent as any).tourScout();
    assert.equal(agent.isStranded(), true, "sanity check: stranded first — nothing fits in the tank at all");

    targets = ["X1-REMOTE-NEAR"];
    (agent as any).navigateTo = async () => {};

    await (agent as any).tourScout();

    assert.equal(agent.isStranded(), false, "recovers on its own next successful tick, no external reset needed");
  });
});

describe("ShipAgent.tourScout: tops off fuel at every market, not just when running low", () => {
  // The insurance against the stranding above: a habit of buying fuel
  // whenever docked somewhere that sells it, rather than only once fuel is
  // already low, so a ship never enters a fuel-sparse system already close
  // to empty.
  it("tops off on arrival even at a comfortable, non-low fuel level", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 280, capacity: 300 }); // 93% — not "low" by the old 90% bar
    const refuelCalls: unknown[] = [];
    const agent = new ShipAgent(ship, {
      api: { getShip: async () => ship } as any,
      log: () => {},
      marketTourTargets: async () => [],
      shipyardTourTargets: async () => [],
    });
    agent.withWorld([{ symbol: "X1-REMOTE-A1", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] }] as any, []);
    (agent as any).refuelIfNeeded = async (reserve: number, target?: string, belowFraction?: number) => {
      refuelCalls.push({ reserve, target, belowFraction });
      return true;
    };
    (agent as any).ensureDocked = async () => {};

    await (agent as any).tourScout();

    assert.ok(
      refuelCalls.some((c: any) => c.belowFraction === 0.95),
      "asks to top off toward a near-full threshold, not just the old 90%-and-low bar",
    );
  });

  it("does not spend a request re-topping an essentially full tank", async () => {
    const ship = makeShip("X1-REMOTE-A1", "X1-REMOTE");
    Object.assign(ship.fuel, { current: 300, capacity: 300 });
    const agent = new ShipAgent(ship, {
      api: {
        getShip: async () => ship,
        refuelShip: async () => { throw new Error("must not be called — already full"); },
      } as any,
      log: () => {},
      marketTourTargets: async () => [],
      shipyardTourTargets: async () => [],
    });
    agent.withWorld([{ symbol: "X1-REMOTE-A1", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] }] as any, []);
    (agent as any).ensureDocked = async () => {};

    // Deliberately not mocking refuelIfNeeded here: this exercises the real
    // ShipProxy implementation's own "enough" short-circuit, not a stub.
    await (agent as any).tourScout();
  });
});
