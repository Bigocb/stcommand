import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipProxy, type Ship } from "../src/engine/shipProxy.js";
import { Registry } from "../src/engine/registry.js";
import { DEFAULT_POLICY, type ShipIntent } from "../src/engine/intent.js";

/**
 * Step 4: an operator hold is a goal the ship flies, not a private flag the
 * fleet sets while flying the hull itself.
 *
 * `holdShip()` used to call `agent.dispatchTo()`, which set `manualGoal` *and*
 * navigated the ship from inside the fleet — rule 1 broken exactly as the
 * repair controller broke it before step 5. It was also a second record of
 * who owned a hull: `isManual()` answered from the agent, the arbiter
 * answered from the intent board, and the dashboard read one while the engine
 * acted on the other. An operator hit Hold, watched the sheet keep saying
 * "Under doctrine", and reasonably concluded the button had not worked.
 *
 * Now the operator proposes like any other controller and `runHoldGoal()`
 * flies it, re-deriving position every tick.
 */

function world(): Registry {
  const r = Registry.standalone();
  r.seed([
    { symbol: "X1-A-A1", x: 0, y: 0 },
    { symbol: "X1-A-B2", x: 3, y: 4 },
  ]);
  return r;
}

function ship(waypoint: string, status = "IN_ORBIT"): Ship {
  return {
    symbol: "SHIP-1",
    nav: { status, waypointSymbol: waypoint, systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    fuel: { current: 400, capacity: 400 },
    cargo: { capacity: 40, units: 0, inventory: [] },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
}

const hold = (waypoint?: string, version = 1): ShipIntent => ({
  ship: "SHIP-1", version, priority: 0,
  goal: { kind: "hold", ...(waypoint ? { waypoint } : {}) },
  policy: DEFAULT_POLICY, reason: "held by the operator", source: "operator",
});

function proxy(at: string, status = "IN_ORBIT") {
  const navigations: string[] = [];
  const s = ship(at, status);
  const p = new ShipProxy(s, {
    api: {
      getShip: async () => s,
      navigateShip: async (_sym: string, wp: string) => { navigations.push(wp); return { nav: s.nav, fuel: s.fuel }; },
      refuelShip: async () => ({ fuel: s.fuel, transaction: { totalPrice: 0 } }),
      dockShip: async () => ({ nav: s.nav }),
      orbitShip: async () => ({ nav: s.nav }),
    } as never,
    registry: world(),
  });
  return { p, navigations };
}

describe("ShipProxy.runHoldGoal", () => {
  it("flies to the hold waypoint when the ship is somewhere else", async () => {
    const { p, navigations } = proxy("X1-A-A1");
    assert.equal(await p.runHoldGoal(hold("X1-A-B2"), () => hold("X1-A-B2")), true);
    assert.deepEqual(navigations, ["X1-A-B2"], "the hull flies its own hold now, the fleet does not fly it");
  });

  it("reports no work once parked, so a held ship gets the idle backoff", async () => {
    const { p, navigations } = proxy("X1-A-B2");
    assert.equal(await p.runHoldGoal(hold("X1-A-B2"), () => hold("X1-A-B2")), false);
    assert.deepEqual(navigations, [], "nothing to do is not the same as work done");
  });

  it("does not move for a hold with no waypoint — that is 'nothing worth doing'", async () => {
    const { p, navigations } = proxy("X1-A-A1");
    assert.equal(await p.runHoldGoal(hold(), () => hold()), false);
    assert.deepEqual(navigations, []);
  });

  it("abandons a hold superseded while it was still flying", async () => {
    // The same guarantee runRepairGoal() gets from supersedes(): a hold
    // placed two ticks ago must not still be acted on if the board has
    // since moved this hull to something more urgent.
    const { p, navigations } = proxy("X1-A-A1");
    const started = hold("X1-A-B2", 1);
    const now: ShipIntent = { ...hold("X1-A-B2", 2), goal: { kind: "repair", yard: "X1-A-B2" }, priority: 1 };
    assert.equal(await p.runHoldGoal(started, () => now), true);
    assert.deepEqual(navigations, [], "a superseded hold must not still fly the ship");
  });

  it("ignores a goal that is not a hold", async () => {
    const { p, navigations } = proxy("X1-A-A1");
    const repair: ShipIntent = { ...hold("X1-A-B2"), goal: { kind: "repair", yard: "X1-A-B2" } };
    assert.equal(await p.runHoldGoal(repair, () => repair), false);
    assert.deepEqual(navigations, []);
  });
});
