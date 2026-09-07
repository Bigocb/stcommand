import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipProxy, type Ship } from "../src/engine/shipProxy.js";
import { Registry } from "../src/engine/registry.js";
import { NavigationPending, CooldownPending, Pending } from "../src/engine/agentStep.js";
import { DEFAULT_POLICY, type ShipIntent } from "../src/engine/intent.js";

/**
 * Step 3 of docs/control-plane-data-plane.md: the one movement primitive every
 * ship role shares.
 *
 * The value of this class is that behaviours below used to exist in some of
 * the four agent files and not others, and fixing one left the rest wrong.
 * Each test names the divergence it pins.
 */

function world(): Registry & { seed(w: readonly { symbol: string; x: number; y: number }[]): void } {
  const r = Registry.standalone();
  r.seed([
    { symbol: "X1-A-A1", x: 0, y: 0 },
    { symbol: "X1-A-B2", x: 30, y: 40 }, // 50 units from A1
    { symbol: "X1-A-FAR", x: 900, y: 0 },
  ]);
  return r;
}

function ship(over: Partial<Ship> = {}): Ship {
  return {
    symbol: "SHIP-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    fuel: { current: 400, capacity: 400 },
    cargo: { capacity: 40, units: 0, inventory: [] },
    cooldown: { remainingSeconds: 0 },
    mounts: [],
    modules: [],
    ...over,
  } as unknown as Ship;
}

const arrivalIn = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("ShipProxy.navigateTo: the post-orbit re-check", () => {
  it("does not fire a second navigate at a waypoint the ship just arrived at", async () => {
    // Only agent.ts had this. A ship already IN_TRANSIT toward the target (a
    // real in-flight navigate surviving a process restart) has its arrival
    // waited out by ensureInOrbit(), which refreshes — but the guard at the
    // top of navigateTo already ran before that wait. Without the second
    // check, scout, siphoner and trader all issued a redundant navigate at
    // the waypoint they had just been confirmed to be standing on.
    let navigates = 0;
    const inTransit = ship({ nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-B2", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(Date.now() - 1000).toISOString() } } } as any);
    const arrived = ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-B2", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any);

    const proxy = new ShipProxy(inTransit, {
      api: {
        getShip: async () => arrived,
        navigateShip: async () => { navigates += 1; throw new Error("should never be called"); },
      } as any,
      registry: world(),
    });

    await proxy.navigateTo("X1-A-B2");
    assert.equal(navigates, 0, "the ship is already there once the transit is waited out");
  });
});

describe("ShipProxy.navigateTo: already-at-destination recovery", () => {
  it("recognises the live API's real wording, which the older patterns missed", async () => {
    // agent.ts documented that the server actually says "is currently located
    // at the destination", and that the checks for "already located at the
    // destination" / "already at the destination" do NOT match it. siphoner.ts
    // still carried the old pattern, so a genuine already-there response was
    // reported as a navigation failure.
    const s = ship();
    const proxy = new ShipProxy(s, {
      api: {
        getShip: async () => ship({ nav: { ...s.nav, waypointSymbol: "X1-A-B2" } } as any),
        navigateShip: async () => { throw new Error("Ship SHIP-1 is currently located at the destination."); },
        patchShipNav: async () => ({ nav: s.nav, fuel: s.fuel }),
      } as any,
      registry: world(),
    });

    await proxy.navigateTo("X1-A-B2"); // must resolve, not throw
    assert.equal(proxy.getShip().nav.waypointSymbol, "X1-A-B2", "refreshed to the real position");
    assert.deepEqual(proxy.getStep(), { kind: "idle" });
  });

  it("still propagates a genuine navigation rejection", async () => {
    const s = ship();
    const proxy = new ShipProxy(s, {
      api: {
        getShip: async () => s,
        navigateShip: async () => { throw new Error("Navigate request failed: requires 96 more fuel"); },
        patchShipNav: async () => ({ nav: s.nav, fuel: s.fuel }),
      } as any,
      registry: world(),
    });
    await assert.rejects(() => proxy.navigateTo("X1-A-B2"), /requires 96 more fuel/);
  });
});

describe("ShipProxy: flight mode never comes from an unmeasured distance", () => {
  it("falls back to CRUISE rather than leaving a ship stuck in DRIFT", async () => {
    // Both halves matter. Feeding an unmeasurable distance to chooseFlightMode
    // reads as "cannot afford CRUISE" and returns DRIFT every time, which cost
    // a trader 7h34m on a 172-unit leg with a nearly full tank. But simply
    // skipping the decision is also wrong, because DRIFT is sticky.
    const s = ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "DRIFT", route: { arrival: new Date().toISOString() } } } as any);
    const patched: string[] = [];
    const proxy = new ShipProxy(s, {
      api: {
        getShip: async () => s,
        patchShipNav: async (_sym: string, mode: string) => { patched.push(mode); return { nav: { ...s.nav, flightMode: mode }, fuel: s.fuel }; },
        navigateShip: async () => ({ nav: { ...s.nav, route: { arrival: arrivalIn(5_000) } }, fuel: s.fuel }),
      } as any,
      registry: world(),
    });
    (proxy as any).schedulerDriven = true;

    // X1-A-GHOST has no position, so the distance is unmeasurable.
    await assert.rejects(() => proxy.navigateTo("X1-A-GHOST"), (e: unknown) => e instanceof NavigationPending);
    assert.deepEqual(patched, ["CRUISE"], "an unmeasurable leg must never be flown at DRIFT by default");
  });

  it("uses a measured distance normally", async () => {
    const s = ship({ fuel: { current: 60, capacity: 400 } } as any);
    const patched: string[] = [];
    const proxy = new ShipProxy(s, {
      api: {
        getShip: async () => s,
        patchShipNav: async (_sym: string, mode: string) => { patched.push(mode); return { nav: { ...s.nav, flightMode: mode }, fuel: s.fuel }; },
        navigateShip: async () => ({ nav: { ...s.nav, route: { arrival: arrivalIn(5_000) } }, fuel: s.fuel }),
      } as any,
      registry: world(),
    });
    (proxy as any).schedulerDriven = true;

    // 900 units away on 60 fuel: genuinely unaffordable at cruise.
    await assert.rejects(() => proxy.navigateTo("X1-A-FAR"), (e: unknown) => e instanceof NavigationPending);
    assert.deepEqual(patched, ["DRIFT"], "a real measurement may still choose DRIFT");
  });
});

describe("ShipProxy: waiting yields the scheduler", () => {
  it("navigateTo throws NavigationPending at the real arrival time", async () => {
    const s = ship();
    const arrival = arrivalIn(45_000);
    const proxy = new ShipProxy(s, {
      api: {
        getShip: async () => s,
        patchShipNav: async () => ({ nav: s.nav, fuel: s.fuel }),
        navigateShip: async () => ({ nav: { ...s.nav, status: "IN_TRANSIT", route: { arrival } }, fuel: s.fuel }),
      } as any,
      registry: world(),
    });
    proxy.schedulerDriven = true;

    await assert.rejects(
      () => proxy.navigateTo("X1-A-B2"),
      (err: unknown) => err instanceof NavigationPending && Math.abs(err.resumeAt - new Date(arrival).getTime()) < 200,
    );
    assert.deepEqual(proxy.getStep(), { kind: "navigating", to: "X1-A-B2" }, "still navigating, so the step must say so");
  });

  it("waitCooldown throws CooldownPending when scheduler-driven, and blocks otherwise", async () => {
    const s = ship({ cooldown: { remainingSeconds: 70 } } as any);
    const proxy = new ShipProxy(s, { api: { getShip: async () => s } as any, registry: world() });

    proxy.schedulerDriven = true;
    await assert.rejects(
      () => proxy.waitCooldown(),
      (err: unknown) => err instanceof CooldownPending && err.reason === "cooldown" && err instanceof Pending,
    );

    proxy.schedulerDriven = false;
    const noCooldown = new ShipProxy(ship(), { api: { getShip: async () => ship() } as any, registry: world() });
    await noCooldown.waitCooldown(); // must not throw
  });
});

describe("ShipProxy.ensureDocked", () => {
  it("records the market at the waypoint it docked at", async () => {
    // Prices are only visible to a ship physically present and docked, so this
    // is the single moment they can be captured. Putting it here rather than
    // at each call site is what makes any dock, in any role, refresh the world.
    const orbiting = ship();
    const docked = ship({ nav: { ...orbiting.nav, status: "DOCKED" } } as any);
    const recorded: string[] = [];
    const proxy = new ShipProxy(orbiting, {
      api: { getShip: async () => docked, dockShip: async () => ({}) } as any,
      registry: world(),
      recordMarket: async (wp) => { recorded.push(wp); },
    });

    await proxy.ensureDocked();
    assert.deepEqual(recorded, ["X1-A-A1"]);
  });

  it("is a no-op when already docked, so it never re-records", async () => {
    const docked = ship({ nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any);
    const recorded: string[] = [];
    const proxy = new ShipProxy(docked, {
      api: { getShip: async () => docked, dockShip: async () => { throw new Error("must not dock twice"); } } as any,
      registry: world(),
      recordMarket: async (wp) => { recorded.push(wp); },
    });
    await proxy.ensureDocked();
    assert.deepEqual(recorded, []);
  });
});

/**
 * Rule 5, as a shared primitive.
 *
 * The check began as the trader's own private method, because the trader was
 * the role that had lost money to its absence. Then the miner's
 * executeArbitrage() turned out to have the identical straight-line shape,
 * and both sellAllCargo() implementations sold wherever the ship happened to
 * be standing. Fixing one and leaving the rest wrong is the exact failure
 * mode this class exists to end, so the check lives here now and every role
 * calls the same one.
 */
describe("ShipProxy.assertAt: a transaction happens where the plan says, or not at all", () => {
  const at = (waypoint: string) =>
    new ShipProxy(
      ship({ nav: { status: "DOCKED", waypointSymbol: waypoint, systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      { api: {} as any, registry: world() },
    );

  it("throws when the ship is somewhere else, naming both waypoints", () => {
    assert.throws(
      () => at("X1-A-A1").assertAt("X1-A-B2", "buy ANTIMATTER"),
      /refusing to buy ANTIMATTER at X1-A-B2: ship is at X1-A-A1/,
      "the message has to name where it actually is, or the log is another false report",
    );
  });

  it("permits the transaction when the ship really is there", () => {
    assert.doesNotThrow(() => at("X1-A-B2").assertAt("X1-A-B2", "sell ANTIMATTER"));
  });

  it("reads the ship's live position, not a copy taken earlier", () => {
    // The reason this belongs on the proxy rather than in each agent: an
    // agent checking its own cached ship would be comparing the plan against
    // the plan. setShip() is what a refresh() after a navigate does.
    const proxy = at("X1-A-A1");
    assert.throws(() => proxy.assertAt("X1-A-B2", "sell ORE"));
    proxy.setShip(ship({ nav: { status: "DOCKED", waypointSymbol: "X1-A-B2", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any));
    assert.doesNotThrow(() => proxy.assertAt("X1-A-B2", "sell ORE"), "an arrival must clear the guard");
  });
});

/**
 * Step 5: explore and tender are goals the ship flies itself, not the controller.
 *
 * Before this change, `autoExplore()` proposed an intent and then immediately
 * called `exploreSystem()` which called `jumpShip`/`surveyMarkets`/`dispatchShip`
 * directly — two owners on the same hull, the same rule 1 break the repair
 * controller caused before step 4. The same applied to `tenderRescueStep()`.
 *
 * Now the controller proposes the full intent and releases; `runExploreGoal()`
 * and `runTenderGoal()` on the ship's own executor drive it to completion.
 *
 * These tests verify the executor flies the hull and calls `done()` on
 * completion or supersession. They are the step-8 tests: they fail with the
 * old controller-driven code (which never calls `done()` and drives the ship
 * from outside the executor) and pass once the fix is in.
 */

function makeExploreIntent(
  overrides: Partial<{ version: number; system: string; gate: string; remoteGate: string; markets: string[] }> = {},
): ShipIntent {
  return {
    ship: "SHIP-1",
    version: overrides.version ?? 1,
    priority: 3,
    goal: {
      kind: "explore",
      system: overrides.system ?? "X1-B",
      gate: overrides.gate ?? "X1-A-GATE",
      remoteGate: overrides.remoteGate ?? "X1-B-GATE",
      markets: overrides.markets ?? ["X1-B-M1", "X1-B-M2"],
    },
    policy: DEFAULT_POLICY,
    reason: "X1-B is unsurveyed",
    source: "explore",
  };
}

function makeTenderIntent(
  overrides: Partial<{ version: number; to: string; fuelUnits: number; market: string; strandedSymbol: string }> = {},
): ShipIntent {
  return {
    ship: "SHIP-1",
    version: overrides.version ?? 1,
    priority: 0,
    goal: {
      kind: "tender",
      to: overrides.to ?? "X1-A-S1",
      fuelUnits: overrides.fuelUnits ?? 30,
      market: overrides.market ?? "X1-A-M1",
      strandedSymbol: overrides.strandedSymbol ?? "SHIP-2",
    },
    policy: DEFAULT_POLICY,
    reason: "ferrying 30u FUEL to SHIP-2",
    source: "rescue",
  };
}

describe("ShipProxy.runExploreGoal: the executor flies the hull", () => {
  it("GATE phase: navigates to the gate when not already there", async () => {
    const navs: string[] = [];
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-GATE", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
          navigateShip: async (_s: string, wp: string) => { navs.push(wp); return {} as any; },
        } as any,
        registry: world(),
        done: () => {},
      },
    );

    const intent = makeExploreIntent();
    const current = () => intent;
    const result = await proxy.runExploreGoal(intent, current);
    assert.equal(result, true, "still working");
    assert.deepEqual(navs, ["X1-A-GATE"], "the executor navigates to the gate, not the controller");
  });

  it("JUMP phase: jumps, loads the target system, advances to SURVEY", async () => {
    const jumps: string[] = [];
    const systemLoaded: string[] = [];
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-GATE", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-B-GATE", systemSymbol: "X1-B", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
          jumpShip: async (_s: string, gate: string) => { jumps.push(gate); return {} as any; },
        } as any,
        registry: world(),
        galaxy: { loadSystem: async (sys: string) => { systemLoaded.push(sys); } } as any,
        done: () => {},
      },
    );

    const intent = makeExploreIntent();
    const current = () => intent;
    const result = await proxy.runExploreGoal(intent, current);
    assert.equal(result, true, "still working");
    assert.deepEqual(jumps, ["X1-B-GATE"], "the executor jumps, not the controller");
    assert.deepEqual(systemLoaded, ["X1-B"], "target system loaded so the registry knows the ship moved");
  });

  it("MARKET phase: visits each pre-computed market and records it", async () => {
    const navs: string[] = [];
    const recorded: string[] = [];
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-B-GATE", systemSymbol: "X1-B", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-B-M2", systemSymbol: "X1-B", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
          navigateShip: async (_s: string, wp: string) => { navs.push(wp); return {} as any; },
        } as any,
        registry: world(),
        galaxy: { loadSystem: async () => {}, surveyMarkets: async () => {} } as any,
        recordMarket: async (wp: string) => { recorded.push(wp); },
        done: () => {},
      },
    );

    // Pretend we've already done GATE, JUMP, SURVEY — seed the phase map
    (proxy as any).explorePhase.set("SHIP-1", "market");
    const intent = makeExploreIntent();
    const current = () => intent;
    const result = await proxy.runExploreGoal(intent, current);
    assert.equal(result, true, "still working after first market");
    assert.deepEqual(navs, ["X1-B-M1"], "navigates to first market");
    assert.deepEqual(recorded, ["X1-B-M1"], "records the market");
  });

  it("DONE: calls done() and returns false", async () => {
    let doneCalled = false;
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-B-M2", systemSymbol: "X1-B", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: { getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-B-M2", systemSymbol: "X1-B", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any) } as any,
        registry: world(),
        galaxy: { loadSystem: async () => {}, surveyMarkets: async () => {} } as any,
        recordMarket: async () => {},
        done: () => { doneCalled = true; },
      },
    );

    // Pretend all markets are done
    (proxy as any).explorePhase.set("SHIP-1", "done");
    const intent = makeExploreIntent();
    const current = () => intent;
    const result = await proxy.runExploreGoal(intent, current);
    assert.equal(result, false, "no more work");
    assert.equal(doneCalled, true, "done() called so the fleet forgets the intent");
  });

  it("superseded: calls done() and returns false without doing work", async () => {
    const navs: string[] = [];
    let doneCalled = false;
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-GATE", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
          navigateShip: async (_s: string, wp: string) => { navs.push(wp); return {} as any; },
        } as any,
        registry: world(),
        done: () => { doneCalled = true; },
      },
    );

    const superseded = makeExploreIntent({ version: 1 });
    const newer = { ...makeExploreIntent({ version: 2 }), goal: { kind: "repair" as const, yard: "X1-A-REPAIR" } };
    const current = (): ShipIntent => newer;
    const result = await proxy.runExploreGoal(superseded, current);
    assert.equal(result, false, "superseded work stops");
    assert.equal(doneCalled, true, "done() called so the fleet forgets the stale intent");
    assert.deepEqual(navs, [], "no navigation attempted with a superseded intent");
  });
});

describe("ShipProxy.runTenderGoal: the executor flies the hull", () => {
  it("BUY phase: navigates to market, docks, refuels and buys FUEL", async () => {
    const navs: string[] = [];
    const docks: string[] = [];
    const refuels: string[] = [];
    const purchases: [string, number][] = [];
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "DOCKED", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() }, fuel: { current: 200, capacity: 400 }, cargo: { capacity: 20, units: 0, inventory: [] } } } as any),
          navigateShip: async (_s: string, wp: string) => { navs.push(wp); return {} as any; },
          dockShip: async (_s: string) => { docks.push(_s); return {} as any; },
          refuelShip: async (s: string) => { refuels.push(s); return { fuel: { current: 400, capacity: 400 }, transaction: { totalPrice: 0 } } as any; },
          purchaseCargo: async (s: string, good: string, units: number) => { purchases.push([good, units]); return { transaction: { totalPrice: 0, units } } as any; },
        } as any,
        registry: world(),
        done: () => {},
      },
    );

    const intent = makeTenderIntent();
    const current = () => intent;
    const result = await proxy.runTenderGoal(intent, current);
    assert.equal(result, true, "still working");
    assert.deepEqual(navs, ["X1-A-M1"], "the executor navigates to the market");
    assert.deepEqual(docks, ["SHIP-1"], "docks before buying");
    assert.equal(refuels.length, 1, "tender tops off its own tank");
    assert.deepEqual(purchases, [["FUEL", 30]], "buys the fuel units for the stranded ship");
  });

  it("TRANSIT phase: navigates to the stranded ship waypoint", async () => {
    const navs: string[] = [];
    const proxy = new ShipProxy(
      ship({ nav: { status: "DOCKED", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() }, fuel: { current: 400, capacity: 400 }, cargo: { capacity: 20, units: 30, inventory: [{ symbol: "FUEL", units: 30 }] } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-S1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
          navigateShip: async (_s: string, wp: string) => { navs.push(wp); return {} as any; },
          orbitShip: async () => ({} as any),
        } as any,
        registry: world(),
        done: () => {},
      },
    );

    (proxy as any).tenderPhase.set("SHIP-1", "transit");
    const intent = makeTenderIntent();
    const current = () => intent;
    const result = await proxy.runTenderGoal(intent, current);
    assert.equal(result, true, "still working");
    assert.deepEqual(navs, ["X1-A-S1"], "navigates to the stranded ship's waypoint");
  });

  it("TRANSFER phase: aligns dock state, transfers FUEL and refuels the stranded ship", async () => {
    const transfers: [string, number][] = [];
    const refuels: string[] = [];
    const tNav = { status: "IN_ORBIT" as const, waypointSymbol: "X1-A-S1", systemSymbol: "X1-A", flightMode: "CRUISE" as const, route: { arrival: new Date().toISOString() } };
    const tCargo = { capacity: 20, units: 30, inventory: [{ symbol: "FUEL" as const, units: 30 }] };
    const tFuel = { current: 400, capacity: 400 };
    const tenderAtS1 = ship({ nav: tNav, fuel: tFuel, cargo: tCargo } as any);
    const sNav = { status: "IN_ORBIT" as const, waypointSymbol: "X1-A-S1", systemSymbol: "X1-A", flightMode: "CRUISE" as const, route: { arrival: new Date().toISOString() } };
    const sCargo = { capacity: 20, units: 10, inventory: [{ symbol: "ORE" as const, units: 10 }] };
    const strandedWithOre = ship({ nav: sNav, cargo: sCargo } as any);
    const proxy = new ShipProxy(tenderAtS1, {
      api: {
        getShip: async () => strandedWithOre,
        orbitShip: async () => ({} as any),
        dockShip: async () => ({} as any),
        jettisonCargo: async (_s: string, _g: string, _u: number) => {},
        transferCargo: async (_s: string, good: string, units: number, _t: string) => { transfers.push([good, units]); return {} as any; },
        refuelShip: async (s: string) => { refuels.push(s); return { fuel: { current: 400, capacity: 400 }, transaction: { totalPrice: 0 } } as any; },
      } as any,
      registry: world(),
      done: () => {},
    });

    (proxy as any).tenderPhase.set("SHIP-1", "transfer");
    const intent = makeTenderIntent();
    const current = () => intent;
    const result = await proxy.runTenderGoal(intent, current);
    assert.equal(result, true, "still working after transfer");
    assert.equal(transfers.length, 1, "transfers FUEL to the stranded ship");
    assert.equal(refuels.length, 1, "refuels the stranded ship");
    assert.equal(refuels[0], "SHIP-2", "refuels the stranded ship, not the tender");
  });

  it("DONE: calls done() and returns false", async () => {
    let doneCalled = false;
    const doneNav = { status: "DOCKED" as const, waypointSymbol: "X1-A-S1", systemSymbol: "X1-A", flightMode: "CRUISE" as const, route: { arrival: new Date().toISOString() } };
    const doneCargo = { capacity: 20, units: 0, inventory: [] };
    const doneFuel = { current: 400, capacity: 400 };
    const d1 = ship({ nav: doneNav, fuel: doneFuel, cargo: doneCargo } as any);
    const proxy = new ShipProxy(d1, {
      api: {
        getShip: async () => d1,
        orbitShip: async () => ({} as any),
        dockShip: async () => ({} as any),
        jettisonCargo: async () => {},
        transferCargo: async () => ({} as any),
        refuelShip: async () => ({ fuel: { current: 400, capacity: 400 }, transaction: { totalPrice: 0 } } as any),
      } as any,
      registry: world(),
      done: () => { doneCalled = true; },
    });

    (proxy as any).tenderPhase.set("SHIP-1", "done");
    const intent = makeTenderIntent();
    const current = () => intent;
    const result = await proxy.runTenderGoal(intent, current);
    assert.equal(result, false, "no more work");
    assert.equal(doneCalled, true, "done() called so the fleet forgets the intent");
  });

  it("superseded: calls done() and returns false without doing work", async () => {
    const navs: string[] = [];
    let doneCalled = false;
    const proxy = new ShipProxy(
      ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
      {
        api: {
          getShip: async () => ship({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } } } as any),
          navigateShip: async (_s: string, wp: string) => { navs.push(wp); return {} as any; },
        } as any,
        registry: world(),
        done: () => { doneCalled = true; },
      },
    );

    const superseded = makeTenderIntent({ version: 1 });
    const newer = { ...makeTenderIntent({ version: 2 }), goal: { kind: "hold" as const, waypoint: "X1-A-A1" } };
    const current = (): ShipIntent => newer;
    const result = await proxy.runTenderGoal(superseded, current);
    assert.equal(result, false, "superseded work stops");
    assert.equal(doneCalled, true, "done() called so the fleet forgets the stale intent");
    assert.deepEqual(navs, [], "no navigation attempted with a superseded intent");
  });
});
