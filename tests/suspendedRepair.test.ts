import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSuspendedRepairs, DEFAULT_SUSPENDED_REPAIR_POLICY, type SuspendedRepairFacts } from "../src/engine/suspendedRepair.js";

const base: SuspendedRepairFacts = {
  shipSymbol: "THEOREM-7", suspended: true, condition: 0.17, nav: "IN_ORBIT",
  system: "X1-CM13", waypoint: "X1-CM13-EZ5F", atShipyard: false, nearestYard: "X1-CM13-A2",
};
const one = (f: Partial<SuspendedRepairFacts>) => planSuspendedRepairs([{ ...base, ...f }])[0]!;

describe("planSuspendedRepairs", () => {
  it("flies a suspended, damaged ship to the nearest yard in its own system", () => {
    const d = one({});
    assert.deepEqual(d.action, { kind: "fly", yard: "X1-CM13-A2" });
    assert.match(d.reason, /0\.17.*flying to X1-CM13-A2/);
  });

  it("docks a ship that is in orbit at a shipyard, rather than sending it to the yard it is already at", () => {
    assert.deepEqual(one({ nav: "IN_ORBIT", atShipyard: true, waypoint: "X1-CM13-A2" }).action, { kind: "dock" });
  });

  it("repairs a docked ship that is already at a shipyard", () => {
    assert.deepEqual(one({ nav: "DOCKED", atShipyard: true, waypoint: "X1-CM13-A2" }).action, { kind: "repair" });
  });

  it("does not repair a docked ship that is not at a shipyard: it flies there", () => {
    assert.deepEqual(one({ nav: "DOCKED", atShipyard: false }).action, { kind: "fly", yard: "X1-CM13-A2" });
  });

  it("waits for a ship in transit", () => {
    assert.deepEqual(one({ nav: "IN_TRANSIT" }).action, { kind: "wait" });
  });

  it("leaves a ship alone when its agent is running: the agent repairs itself", () => {
    const d = one({ suspended: false });
    assert.deepEqual(d.action, { kind: "none" });
    assert.match(d.reason, /running/);
  });

  it("leaves a healthy ship alone", () => {
    assert.deepEqual(one({ condition: 0.9 }).action, { kind: "none" });
  });

  it("uses the floor from the policy, not a fixed number", () => {
    assert.deepEqual(one({ condition: 0.6 }).action, { kind: "none" });
    assert.deepEqual(planSuspendedRepairs([{ ...base, condition: 0.6 }], { enabled: true, floor: 0.7 })[0]!.action, { kind: "fly", yard: "X1-CM13-A2" });
  });

  it("does nothing when the policy is off", () => {
    const d = planSuspendedRepairs([base], { ...DEFAULT_SUSPENDED_REPAIR_POLICY, enabled: false })[0]!;
    assert.deepEqual(d.action, { kind: "none" });
    assert.equal(d.reason, "suspended repairs are off");
  });

  it("reports when a system has no known shipyard, rather than inventing a route", () => {
    const d = one({ nearestYard: undefined });
    assert.deepEqual(d.action, { kind: "none" });
    assert.match(d.reason, /no known shipyard in X1-CM13/);
  });

  it("decides each ship separately", () => {
    const out = planSuspendedRepairs([base, { ...base, shipSymbol: "THEOREM-8", condition: 0.9 }]);
    assert.equal(out[0]!.shipSymbol, "THEOREM-7");
    assert.deepEqual(out[1]!.action, { kind: "none" });
  });
});
