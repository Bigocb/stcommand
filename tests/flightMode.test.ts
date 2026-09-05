import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseFlightMode } from "../src/engine/flightMode.js";
import { TraderAgent, type Ship as TraderShip } from "../src/engine/trader.js";
import { SiphonerAgent } from "../src/engine/siphoner.js";
import { NavigationPending } from "../src/engine/agentStep.js";

const rejectsWithPending = (err: unknown) => err instanceof NavigationPending;

/**
 * See src/engine/flightMode.ts's own comment for the full policy rationale
 * and the honest caveat: DRIFT's exact fuel/time formula isn't verified
 * against the live game here (docs.spacetraders.io was unreachable from
 * this environment) — what these tests pin down is the *decision logic*
 * around a distance-based fuel estimate the caller already computes, not
 * the game's own underlying fuel math.
 */
describe("chooseFlightMode", () => {
  it("chooses DRIFT when the ship can't afford this leg at CRUISE — the stranding-avoidance case", () => {
    assert.equal(chooseFlightMode(50, 30, 100), "DRIFT");
  });

  it("chooses CRUISE when fuel covers the leg but without enough headroom for BURN", () => {
    assert.equal(chooseFlightMode(50, 60, 100), "CRUISE");
  });

  it("chooses BURN when fuel comfortably covers double the CRUISE cost with a real reserve left over", () => {
    // needs >= 2*50=100 for BURN's cost, plus a 25% (of 200) reserve after
    // that = 150. 180 clears both.
    assert.equal(chooseFlightMode(50, 180, 200), "BURN");
  });

  it("does not choose BURN just because the leg is affordable twice over, if it would leave too little reserve", () => {
    // Exactly enough for 2x cost (100) but nothing left over — must not burn
    // through the tank chasing speed with no margin for what comes after.
    assert.equal(chooseFlightMode(50, 100, 100), "CRUISE");
  });

  it("a fuel-independent ship (capacity 0) always reports CRUISE — flight mode is meaningless for it", () => {
    assert.equal(chooseFlightMode(0, 0, 0), "CRUISE");
  });

  it("boundary: exactly enough fuel for the leg at CRUISE is not DRIFT", () => {
    assert.equal(chooseFlightMode(50, 50, 100), "CRUISE");
  });

  it("boundary: one fuel short of the leg's CRUISE cost is DRIFT, even with a huge tank otherwise", () => {
    assert.equal(chooseFlightMode(50, 49, 1000), "DRIFT");
  });
});

describe("navigateTo() wires flight mode selection into the real navigate call", () => {
  // schedulerDriven=true makes a successful navigate throw NavigationPending
  // right away (see trader.ts's waitForArrival()) instead of really waiting
  // out the transit — fast and deterministic, and irrelevant to what these
  // tests actually check (the flight-mode patch happens earlier, before any
  // of that). getShip() is still required either way: waitForArrival()'s
  // non-blocking branch always refreshes first (see its own comment).

  it("TraderAgent selects DRIFT and patches it before navigating, when the leg is unaffordable at CRUISE", async () => {
    const ship: TraderShip = {
      symbol: "SHIP-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE" },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 5, capacity: 100 }, // far too little for a real CRUISE leg
    } as unknown as TraderShip;
    let patchedMode: string | undefined;
    let navigated = false;
    let liveNav: any = ship.nav;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        orbitShip: async () => { liveNav = { ...liveNav, status: "IN_ORBIT" }; return { nav: liveNav }; },
        getShip: async () => ({ ...ship, nav: liveNav }),
        patchShipNav: async (_s: string, mode: string) => {
          patchedMode = mode;
          liveNav = { ...liveNav, flightMode: mode };
          return { nav: liveNav, fuel: ship.fuel };
        },
        navigateShip: async () => {
          navigated = true;
          liveNav = { ...liveNav, status: "IN_TRANSIT", route: { arrival: new Date(Date.now() + 30_000).toISOString(), departureTime: new Date().toISOString() } };
          return { nav: liveNav, fuel: ship.fuel };
        },
      } as any,
    });
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-B1", x: 500, y: 500 }, // far enough that the CRUISE fuel estimate exceeds the 5 units in the tank
    ]);
    (trader as any).schedulerDriven = true;

    await assert.rejects(() => (trader as any).navigateTo("X1-A-B1"), rejectsWithPending);

    assert.equal(patchedMode, "DRIFT");
    assert.ok(navigated, "the real navigate call must still happen — the game, not a local estimate, is the final authority on whether DRIFT makes the leg affordable");
  });

  it("SiphonerAgent: a leg unaffordable at CRUISE now attempts DRIFT instead of returning false without ever calling navigateShip (regression: this used to give up locally and never touch the API at all)", async () => {
    let liveNav: any = { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE" };
    const ship = { symbol: "SHIP-1", nav: liveNav, cargo: { capacity: 40, units: 0, inventory: [] }, fuel: { current: 5, capacity: 100 } } as any;
    let patchedMode: string | undefined;
    let navigated = false;
    const siphoner = new SiphonerAgent(ship, {
      api: {
        getCallCount: () => 0,
        getShip: async () => ({ ...ship, nav: liveNav }),
        patchShipNav: async (_s: string, mode: string) => {
          patchedMode = mode;
          liveNav = { ...liveNav, flightMode: mode };
          return { nav: liveNav, fuel: ship.fuel };
        },
        navigateShip: async () => {
          navigated = true;
          liveNav = { ...liveNav, status: "IN_TRANSIT", route: { arrival: new Date(Date.now() + 30_000).toISOString(), departureTime: new Date().toISOString() } };
          return { nav: liveNav, fuel: ship.fuel };
        },
      } as any,
    }).withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-B1", x: 500, y: 500 },
    ] as any);
    (siphoner as any).schedulerDriven = true;

    await assert.rejects(() => (siphoner as any).navigateTo("X1-A-B1"), rejectsWithPending);

    assert.equal(patchedMode, "DRIFT");
    assert.ok(navigated, "must attempt the real navigate call in DRIFT mode instead of giving up locally");
  });

  it("does not attempt a flight-mode patch when the chosen mode already matches the ship's current one", async () => {
    const ship: TraderShip = {
      symbol: "SHIP-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE" },
      cargo: { capacity: 40, units: 0, inventory: [] },
      // needAtCruise ~= 40 (distance 28,28 below): 50 covers it (not DRIFT)
      // but 50 < 2*40=80 (not enough for BURN either) -> CRUISE, same as
      // the ship's already-set mode.
      fuel: { current: 50, capacity: 100 },
    } as unknown as TraderShip;
    let patchCalled = false;
    let liveNav: any = ship.nav;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        orbitShip: async () => { liveNav = { ...liveNav, status: "IN_ORBIT" }; return { nav: liveNav }; },
        getShip: async () => ({ ...ship, nav: liveNav }),
        patchShipNav: async () => { patchCalled = true; throw new Error("must not be called"); },
        navigateShip: async () => {
          liveNav = { ...liveNav, status: "IN_TRANSIT", route: { arrival: new Date(Date.now() + 30_000).toISOString(), departureTime: new Date().toISOString() } };
          return { nav: liveNav, fuel: ship.fuel };
        },
      } as any,
    });
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-B1", x: 28, y: 28 },
    ]);
    (trader as any).schedulerDriven = true;

    await assert.rejects(() => (trader as any).navigateTo("X1-A-B1"), rejectsWithPending);

    assert.ok(!patchCalled, "already flying the mode chooseFlightMode() would pick — no reason to spend an API call re-setting it");
  });

  it("a flight-mode patch failure does not block the navigate attempt", async () => {
    const ship: TraderShip = {
      symbol: "SHIP-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE" },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 5, capacity: 100 },
    } as unknown as TraderShip;
    let navigated = false;
    let liveNav: any = ship.nav;
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0,
        orbitShip: async () => { liveNav = { ...liveNav, status: "IN_ORBIT" }; return { nav: liveNav }; },
        getShip: async () => ({ ...ship, nav: liveNav }),
        patchShipNav: async () => { throw new Error("simulated patch failure"); },
        navigateShip: async () => {
          navigated = true;
          liveNav = { ...liveNav, status: "IN_TRANSIT", route: { arrival: new Date(Date.now() + 30_000).toISOString(), departureTime: new Date().toISOString() } };
          return { nav: liveNav, fuel: ship.fuel };
        },
      } as any,
    });
    trader.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-B1", x: 500, y: 500 },
    ]);
    (trader as any).schedulerDriven = true;

    await assert.rejects(() => (trader as any).navigateTo("X1-A-B1"), rejectsWithPending); // rejects with NavigationPending, not the simulated patch error

    assert.ok(navigated, "the real navigate attempt must still happen even though setting the flight mode failed");
  });
});

describe("chooseFlightMode: an unmeasured distance must never reach this function", () => {
  // These two assertions are not aspirational — they document why callers are
  // required to check Number.isFinite() before calling. Both sentinels the
  // codebase has used for "no position" select DRIFT on a full tank, and DRIFT
  // succeeds: the ship departs and crawls for hours instead of failing fast.
  // A trader lost 7h34m to exactly this on a leg measured live at 172 units.
  it("selects DRIFT for the pessimistic 1000 sentinel even on a full tank", () => {
    assert.equal(chooseFlightMode(1000, 600, 600), "DRIFT");
  });

  it("selects DRIFT for an Infinity sentinel even on a full tank", () => {
    assert.equal(chooseFlightMode(Infinity, 600, 600), "DRIFT");
  });

  it("picks the fastest mode for that same leg once its real distance is known", () => {
    // 172 units with 598/600 in the tank is not merely affordable at CRUISE —
    // there is enough spare fuel to BURN it. The sentinel inverted the
    // decision as far as it can possibly be inverted: fastest to slowest.
    assert.equal(chooseFlightMode(172, 598, 600), "BURN");
  });
});
