import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mootRoleApprovals } from "../src/engine/approvals.js";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-10-25: THEO-4 and THEO-5 were bought and roled by opening tasks, yet "needs a role" cards for both sat in the Approvals
 * panel. The cards are now withdrawn once the ship is no longer waiting on a role decision.
 */
const row = (id: string, kind: string, status = "pending") => ({ id, kind, status });

describe("mootRoleApprovals", () => {
  it("withdraws a role card for a ship that is not awaiting a role, keeps one that is", () => {
    const open = [row("a", "assignShipRole:THEO-4"), row("b", "assignShipRole:THEO-5")];
    assert.deepEqual(mootRoleApprovals(open, new Set(["THEO-5"])), ["a"]);
  });
  it("leaves every other kind of card alone", () => {
    const open = [row("k", "buyKeeperProbeForMarket"), row("s", "buyShip"), row("d", "assignShipRole:T-1", "approved")];
    assert.deepEqual(mootRoleApprovals(open, new Set()), []);
  });
});

describe("the fleet withdraws them on its tick", () => {
  it("expires the stale card through the store and logs it once", async () => {
    const decided: [string, string, boolean | undefined][] = [];
    const store: any = {
      listOpenApprovals: async () => [row("a", "assignShipRole:THEO-4"), row("z", "buyShip")],
      decideApproval: async (_t: string, id: string, status: string, consumed?: boolean) => { decided.push([id, status, consumed]); },
    };
    const fleet = new FleetManager({ api: { onMarket: () => {} } as any });
    const logs: string[] = [];
    (fleet as any).log = (m: string) => logs.push(m);
    (fleet as any).store = store;
    (fleet as any).tenantId = "t";
    await (fleet as any).maybeResolveNewShipRoles();
    assert.deepEqual(decided, [["a", "expired", true]]);
    assert.ok(logs.some((l) => /withdrew 1 stale role approval/.test(l)));
  });
});
