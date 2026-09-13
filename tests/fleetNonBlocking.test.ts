import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import type { Ship } from "../src/engine/trader.js";

/**
 * Finding 2 of the engine review: the coordinator tick blocked for entire
 * transits.
 *
 * autoExplore() awaited exploreSystem(), which jumps a ship to another system
 * and then tours its markets — minutes of real flight. FleetManager.run()
 * awaits tick() serially, so for that whole time nothing else in the fleet
 * ran: no dispatch recompute, no keeper assignment, no repair, no status sync.
 * The trip is now launched detached, the same shape runCriticalRepair()
 * already used.
 */

function makeShip(symbol: string, over: Partial<Ship> = {}): Ship {
  return {
    symbol,
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 300, capacity: 300 },
    ...over,
  } as unknown as Ship;
}

const scoutAgent = (ship: Ship) => ({
  symbol: ship.symbol,
  getShip: () => ship,
  isManual: () => false,
  isSuspended: () => false,
  isStranded: () => false,
});

/** A galaxy with one reachable, unsurveyed neighbour. */
function seedGalaxy(fleet: FleetManager): void {
  const atlas = (fleet as any).galaxy;
  for (const sys of ["X1-A", "X1-B"]) {
    atlas.systems.set(sys, {
      symbol: sys,
      // A gate is a real waypoint (type JUMP_GATE) as well as an entry in
      // jumpGates — autoExplore()'s remote-gate lookup reads .waypoints the
      // same way fleet.ts's own dispatchShip()/jumpShip() path and
      // trader.ts's cross-system routing already do (both search .waypoints
      // for type === "JUMP_GATE", never .jumpGates). Omitting it here isn't
      // a smaller stub, it's a system shaped unlike anything loadSystem()
      // actually produces — autoExplore() logged "no remote jump gate,
      // skipping" against it and never once proposed a trip.
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
}

describe("autoExplore does not block the coordinator", () => {
  it("returns immediately, having proposed the trip rather than flown it", async () => {
    // exploreSystem() — the fleet-driven method these tests used to mock —
    // no longer exists. Step 5 moved the trip itself onto the scout's own
    // executor (ShipProxy.runExploreGoal, tested in shipProxy.test.ts);
    // autoExplore() now only proposes the intent and records the claim, both
    // synchronous, so "does not block" is no longer about detaching an
    // awaited call — it is that this method was never async work to begin
    // with. What's left to prove is that the launch actually happens: an
    // intent proposed and exploringShips claimed.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedGalaxy(fleet);
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));

    const start = Date.now();
    await (fleet as any).autoExplore();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 500, `autoExplore must not block (took ${elapsed}ms)`);
    fleet.intents.commit();
    assert.equal(fleet.intents.current("SCOUT-1")?.goal.kind, "explore", "but the trip must actually have been proposed");
    assert.equal((fleet as any).exploringShips.has("SCOUT-1"), true, "and the scout claimed so a second pass does not double-dispatch it");
  });

  it("records who owns the scout and why, so a second subsystem cannot take it", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedGalaxy(fleet);
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));
    let release: () => void = () => {};
    const trip = new Promise<void>((r) => { release = r; });
    (fleet as any).exploreSystem = async () => { await trip; };

    await (fleet as any).autoExplore();
    fleet.intents.commit();

    const intent = fleet.intents.current("SCOUT-1");
    assert.equal(intent!.goal.kind, "explore");
    assert.equal(intent!.source, "explore");
    assert.ok(intent!.reason.includes("X1-B"), "the reason names the system, in the operator's words");
    release();
    await trip;
  });

  it("does not launch a second trip for a scout already exploring", async () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    seedGalaxy(fleet);
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));

    await (fleet as any).autoExplore();
    fleet.intents.commit();
    const firstVersion = fleet.intents.current("SCOUT-1")?.version;
    (fleet as any).lastExploreTick = 0; // let the throttle allow another pass
    await (fleet as any).autoExplore();
    fleet.intents.commit();

    assert.equal(
      fleet.intents.current("SCOUT-1")?.version,
      firstVersion,
      "a scout already claimed in exploringShips must not be re-proposed with a new goal",
    );
  });

  it("does not propose a jump to a system whose remote gate is under construction, and remembers not to retry", async () => {
    // The live bug this covers: DRAGOM-C retried the identical doomed jump to
    // X1-YB72 every few minutes for 45+ minutes straight. canJump() (used to
    // pick a target above) only validates the LOCAL gate's construction —
    // exploreSystem() has always separately checked the remote end and
    // recorded a skip, but autoExplore() never did, so nothing here had any
    // memory of the earlier failure.
    const fleet = new FleetManager({
      api: {
        getCallCount: () => 0,
        getConstruction: async () => ({ isComplete: false, materials: [] }),
      } as any,
    });
    seedGalaxy(fleet);
    // X1-A's local gate is complete (seeded true); X1-B's remote gate is not
    // yet known either way, so refreshGateConstruction() actually calls the
    // stubbed API above instead of short-circuiting on an already-cached true.
    (fleet as any).galaxy.gateConstruction.delete("X1-B-GATE");
    (fleet as any).scouts.set("SCOUT-1", scoutAgent(makeShip("SCOUT-1")));

    await (fleet as any).autoExplore();
    fleet.intents.commit();

    assert.equal(fleet.intents.current("SCOUT-1"), undefined, "no goal proposed — the only reachable target's remote gate is not finished");
    assert.ok(
      (fleet as any).gateConstructionSkipUntil.get("X1-B") > Date.now(),
      "the skip is recorded so a later pass does not retry the same doomed target",
    );

    // A second pass, even with the throttle cleared, must not retry X1-B
    // while the skip is still active — this is the part that was missing.
    (fleet as any).lastExploreTick = 0;
    await (fleet as any).autoExplore();
    fleet.intents.commit();
    assert.equal(fleet.intents.current("SCOUT-1"), undefined, "second pass still does not propose the skipped target");
  });
});

describe("escapeByJump does not retry a doomed rescue jump", () => {
  it("does not jump to a system whose remote gate is under construction, and remembers not to retry", async () => {
    // The live bug this covers: DRAGOM-14, stranded at X1-S84's own jump
    // gate, retried the identical doomed jump to X1-YB72 every scheduler
    // cycle (~5-6s) forever — "Destination jump gate ... is under
    // construction" on every single attempt. exploreSystem()/autoExplore()
    // both already check the remote gate and record a skip; escapeByJump()
    // (the stranded-ship rescue path) never did.
    let jumpCalled = false;
    const fleet = new FleetManager({
      api: {
        getCallCount: () => 0,
        getConstruction: async () => ({ isComplete: false, materials: [] }),
        jumpShip: async () => { jumpCalled = true; throw new Error("must not be called"); },
      } as any,
    });
    seedGalaxy(fleet);
    (fleet as any).galaxy.gateConstruction.delete("X1-B-GATE");

    const stranded = { symbol: "SHIP-1", waypointSymbol: "X1-A-GATE", fuel: 0 };
    const escaped = await (fleet as any).escapeByJump(stranded);

    assert.equal(escaped, false, "no viable connected system — the only one has a gate still under construction");
    assert.equal(jumpCalled, false, "must not even attempt the doomed jump");
    assert.ok(
      (fleet as any).gateConstructionSkipUntil.get("X1-B") > Date.now(),
      "the skip is recorded so a later rescue pass does not retry the same doomed target",
    );

    // A second pass must not retry X1-B while the skip is still active.
    const escapedAgain = await (fleet as any).escapeByJump(stranded);
    assert.equal(escapedAgain, false);
    assert.equal(jumpCalled, false, "second pass still does not attempt the skipped target");
  });
});

describe("shipWaypoint/cachedShip know about tour and keeper ships", () => {
  it("estimatedFuelTo() finds a tour ship's real position instead of defaulting to Infinity", () => {
    // Live bug: the dashboard's manual "Send to waypoint" pre-check reported
    // "DRAGOM-14 needs Infinity fuel" for a perfectly healthy 300/300-fuel
    // tour ship. shipWaypoint()/cachedShip() enumerated miners/traders/
    // surveyors/scouts/siphoners/explorers but never tours or keepers, so
    // any ship in either role fell through to idleShips (empty, since the
    // ship is actively touring) and resolved to an unknown "" position —
    // registry.distance("", target) has no way to answer that but Infinity.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    const tourShip = makeShip("TOUR-1", { nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" } as any });
    (fleet as any).tours.set("TOUR-1", scoutAgent(tourShip));
    const keeperShip = makeShip("KEEPER-1", { nav: { status: "DOCKED", waypointSymbol: "X1-A-B2", systemSymbol: "X1-A" } as any });
    (fleet as any).keepers.set("KEEPER-1", scoutAgent(keeperShip));

    assert.equal((fleet as any).shipWaypoint("TOUR-1"), "X1-A-A1");
    assert.equal((fleet as any).shipWaypoint("KEEPER-1"), "X1-A-B2");
    assert.equal((fleet as any).cachedShip("TOUR-1"), tourShip);
    assert.equal((fleet as any).cachedShip("KEEPER-1"), keeperShip);
  });
});

describe("repair and explore no longer take turns driving the same hull", () => {
  it("a critical repair outranks an exploration already assigned", async () => {
    // The live failure: the repair diverter claimed the ship, the tour agent
    // kept flying it, and the two alternated every few seconds all day.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    fleet.intents.propose({ ship: "S1", priority: 3, goal: { kind: "explore", system: "X1-B", gate: "X1-B-GATE", remoteGate: "X1-A-GATE", markets: ["X1-B-MARKET1"] }, reason: "unsurveyed", source: "explore" });
    fleet.intents.commit();
    assert.equal(fleet.intents.current("S1")!.goal.kind, "explore");

    fleet.intents.propose({ ship: "S1", priority: 1, goal: { kind: "repair", yard: "X1-A-YARD" }, reason: "condition 0.00", source: "repair" });
    fleet.intents.commit();

    const intent = fleet.intents.current("S1")!;
    assert.equal(intent.goal.kind, "repair", "one owner, decided by priority");
    assert.equal(intent.version, 2, "and the change is visible as a new version");
  });
});

describe("fleet status reports intent alongside observed state", () => {
  it("says what a ship is doing and what it is supposed to be doing", async () => {
    // Observed state alone cannot distinguish a ship with nothing to do from
    // one whose assignment it cannot carry out. That distinction is exactly
    // what turned "why has this tour sat in orbit for hours" into an
    // investigation across logs rather than a glance at a row.
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    const ship = makeShip("TOUR-1");
    (fleet as any).tours.set("TOUR-1", scoutAgent(ship));
    fleet.intents.propose({ ship: "TOUR-1", priority: 3, goal: { kind: "explore", system: "X1-TV75", gate: "X1-TV75-GATE", remoteGate: "X1-A-GATE", markets: [] }, reason: "X1-TV75 is unsurveyed", source: "explore" });
    fleet.intents.commit();

    const [row] = fleet.fleetStatusSummary().filter((r) => r.symbol === "TOUR-1");
    assert.equal(row!.doing, "in orbit", "what it is");
    assert.equal(row!.wants, "explore X1-TV75", "what it is meant to be");
    assert.equal(row!.wantsReason, "X1-TV75 is unsurveyed");
    assert.equal(row!.wantsSource, "explore", "and which controller decided");
    assert.equal(row!.intentVersion, 1);
  });

  it("names the target, so two goals of the same kind are never confused", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).keepers.set("K1", scoutAgent(makeShip("K1")));
    (fleet as any).keepers.set("K2", scoutAgent(makeShip("K2")));
    fleet.intents.propose({ ship: "K1", priority: 3, goal: { kind: "keep", waypoint: "X1-A-M1" }, reason: "cover", source: "keeper" });
    fleet.intents.propose({ ship: "K2", priority: 3, goal: { kind: "keep", waypoint: "X1-A-M2" }, reason: "cover", source: "keeper" });
    fleet.intents.commit();

    const rows = new Map(fleet.fleetStatusSummary().map((r) => [r.symbol, r.wants]));
    assert.equal(rows.get("K1"), "keep X1-A-M1");
    assert.equal(rows.get("K2"), "keep X1-A-M2");
  });

  it("omits the intent fields entirely for a ship nothing has claimed", () => {
    const fleet = new FleetManager({ api: { getCallCount: () => 0 } as any });
    (fleet as any).scouts.set("S9", scoutAgent(makeShip("S9")));
    const [row] = fleet.fleetStatusSummary().filter((r) => r.symbol === "S9");
    assert.equal(row!.wants, undefined, "an unclaimed ship is genuinely unclaimed, not holding");
  });
});
