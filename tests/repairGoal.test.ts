import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipProxy, type Ship } from "../src/engine/shipProxy.js";
import { Registry } from "../src/engine/registry.js";
import { DEFAULT_POLICY, type ShipIntent } from "../src/engine/intent.js";

/**
 * Step 5: the repair controller proposes and never touches the hull.
 *
 * It used to suspend the agent and fly the ship itself, which rule 1 forbids
 * and which produced exactly the failure the rule predicts — suspend()
 * resolves only after the agent's in-flight iteration finishes, so the
 * controller regularly took a ship that had just been sent somewhere else,
 * and DAGGER-8's repair "ended at X1-KU72-E49, not X1-KU72-A2".
 *
 * It lives in the shared executor rather than one agent class because any
 * hull can take damage: a repair every role can be given but only one role
 * can carry out would be worse than no change at all.
 */

const repairIntent = (version = 1): ShipIntent => ({
  ship: "SHIP-1", version, priority: 1,
  goal: { kind: "repair", yard: "X1-A-YARD" },
  policy: DEFAULT_POLICY, reason: "condition 0.00 is below the critical floor", source: "repair",
});

function world(): Registry {
  const r = Registry.standalone();
  r.seed([{ symbol: "X1-A-A1", x: 0, y: 0 }, { symbol: "X1-A-YARD", x: 10, y: 0 }]);
  return r;
}

function ship(waypoint: string, status = "IN_ORBIT"): Ship {
  return {
    symbol: "SHIP-1",
    nav: { status, waypointSymbol: waypoint, systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
}

function proxyAt(waypoint: string, status = "IN_ORBIT") {
  const s = ship(waypoint, status);
  const repaired: string[] = [];
  const navigated: string[] = [];
  const proxy = new ShipProxy(s, {
    api: { getShip: async () => s, dockShip: async () => ({}) } as never,
    registry: world(),
    log: () => {},
    repairHere: async (sym: string) => { repaired.push(sym); },
  } as never);
  (proxy as never as { navigateTo(w: string): Promise<void> }).navigateTo = async (w: string) => { navigated.push(w); };
  return { proxy, repaired, navigated };
}

describe("a ship flies its own repair goal", () => {
  it("heads for the yard and repairs nothing while away from it", async () => {
    const { proxy, repaired, navigated } = proxyAt("X1-A-A1");
    const intent = repairIntent();
    await proxy.runRepairGoal(intent, () => intent);

    assert.deepEqual(navigated, ["X1-A-YARD"]);
    assert.deepEqual(repaired, [], "repairing before arrival is the bug this closes");
  });

  it("repairs once standing at the yard", async () => {
    const { proxy, repaired, navigated } = proxyAt("X1-A-YARD");
    const intent = repairIntent();
    await proxy.runRepairGoal(intent, () => intent);

    assert.deepEqual(navigated, [], "already there");
    assert.deepEqual(repaired, ["SHIP-1"]);
  });

  it("does not pay for a repair superseded while it was in transit", async () => {
    // What `version` was built for, and what nothing read until now: a rescue
    // outranking the repair, or the hull recovering, must not still be paid
    // for on arrival.
    const { proxy, repaired } = proxyAt("X1-A-YARD");
    const started = repairIntent(1);
    await proxy.runRepairGoal(started, () => repairIntent(2));

    assert.deepEqual(repaired, [], "the board changed its mind before the credits were spent");
  });

  it("does not pay when the goal was dropped entirely", async () => {
    const { proxy, repaired } = proxyAt("X1-A-YARD");
    const started = repairIntent(1);
    await proxy.runRepairGoal(started, () => undefined);
    assert.deepEqual(repaired, []);
  });

  it("survives a repair that throws, rather than killing the tick", async () => {
    const s = ship("X1-A-YARD");
    const proxy = new ShipProxy(s, {
      api: { getShip: async () => s, dockShip: async () => ({}) } as never,
      registry: world(),
      log: () => {},
      repairHere: async () => { throw new Error("insufficient credits"); },
    } as never);
    const intent = repairIntent();
    assert.equal(await proxy.runRepairGoal(intent, () => intent), true);
  });

  it("declines a goal that is not a repair", async () => {
    const { proxy } = proxyAt("X1-A-YARD");
    const other = { ...repairIntent(), goal: { kind: "trade" } } as unknown as ShipIntent;
    assert.equal(await proxy.runRepairGoal(other, () => other), false);
  });
});
