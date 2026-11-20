import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keeperBudget, topUpLimit } from "../src/engine/keeperValue.js";
import { FleetManager } from "../src/engine/fleet.js";

describe("keeper staging reserve (keeperStagingReserve)", () => {
  it("without a reserve the limit works as before", () => {
    assert.equal(keeperBudget({ keepers: 999, max: 1000 }).allow, true);
    assert.equal(keeperBudget({ keepers: 1000, max: 1000 }).allow, false);
    assert.equal(keeperBudget({ keepers: 950, max: 1000, reserve: 0 }).allow, true);
  });
  it("other markets stop at the reserve; staging markets may use it up to the limit", () => {
    const b = { keepers: 950, max: 1000, reserve: 100 };
    assert.equal(keeperBudget(b).allow, false);
    assert.match(keeperBudget(b).reason, /kept for staging/);
    assert.equal(keeperBudget({ ...b, forStaging: true }).allow, true);
    assert.equal(keeperBudget({ ...b, keepers: 1000, forStaging: true }).allow, false, "never past the limit itself");
    assert.equal(keeperBudget({ ...b, keepers: 899 }).allow, true);
  });
  it("top-up works to the limit less the reserve, never to 0 (which would mean no limit)", () => {
    assert.equal(topUpLimit(2000, 100), 1900);
    assert.equal(topUpLimit(2000, 0), 2000);
    assert.equal(topUpLimit(100, 500), 1);
    assert.equal(topUpLimit(0, 100), 0);
  });
});

describe("staging reserve at the fleet seam", () => {
  const fake = (on: boolean) => {
    const self: any = {
      doctrine: {
        isEnabledOr: (k: string, d: boolean) => (k === "keeperStagingReserve" ? on : k === "autoApproveKeeperProbes" || k === "keeperMaxTotal" ? true : d),
        value: (k: string, d?: number) => ({ keeperStagingReserve: 100, keeperMaxTotal: 1000, autoApproveKeeperProbes: 60000 } as Record<string, number>)[k] ?? d ?? 0,
        isEnabled: () => false,
      },
      keepers: new Map(Array.from({ length: 950 }, (_, i) => [`K-${i}`, {}])),
      stagedParked: new Map(),
      systemQueue: { get: (s: string) => (s === "X1-NEW" ? { state: "staged" } : s === "X1-OLD" ? { state: "live" } : undefined) },
      canAfford: () => true,
      credits: 50_000_000,
      keeperRate: { net: 5_000_000 },
    };
    for (const k of ["keeperSlotsUsed", "keeperStagingReserve", "isStagingMarket", "keeperAutoApproves"]) self[k] = (FleetManager.prototype as any)[k].bind(self);
    return self;
  };
  it("on: a live system's market is held back, a staged system's market is bought", () => {
    const f = fake(true);
    assert.equal(f.keeperAutoApproves(30_000, "X1-OLD-A1").blocked, true);
    assert.notEqual(f.keeperAutoApproves(30_000, "X1-NEW-A1").blocked, true);
  });
  it("off: both are bought, as before", () => {
    const f = fake(false);
    assert.notEqual(f.keeperAutoApproves(30_000, "X1-OLD-A1").blocked, true);
  });
});
