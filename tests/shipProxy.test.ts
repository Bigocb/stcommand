import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipProxy, type Ship } from "../src/engine/shipProxy.js";
import { Registry } from "../src/engine/registry.js";
import { NavigationPending, CooldownPending, Pending } from "../src/engine/agentStep.js";

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
