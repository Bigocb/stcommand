import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvalsView } from "../src/engine/approvalsView.js";
import type { Store } from "../src/db/store.js";
import type { FleetManager } from "../src/engine/fleet.js";

/**
 * The `upcoming` group is the Approvals screen's actionable-by-tagging rows: keeper priority markets with no open ask
 * yet. No database: the store and fleet are fakes over the three reads approvalsView makes.
 */
function setup(opts: {
  open?: { kind: string; shipSymbol?: string | null }[];
  decided?: { kind: string; shipSymbol?: string | null }[];
  uncovered?: string[];
}) {
  const store = {
    listOpenApprovals: async () => opts.open ?? [],
    listDecidedApprovals: async () => opts.decided ?? [],
  } as unknown as Store;
  const fleet = { priorityUncovered: async () => opts.uncovered ?? [] } as unknown as FleetManager;
  return approvalsView(store, fleet, "t1");
}

describe("approvalsView upcoming", () => {
  it("lists every uncovered priority market when nothing has an open ask", async () => {
    const v = await setup({ uncovered: ["X1-A-A", "X1-A-B"] });
    assert.deepEqual(v.upcoming, ["X1-A-A", "X1-A-B"]);
  });

  it("drops a market that already has an open keeper ask (target packed into shipSymbol)", async () => {
    const v = await setup({
      open: [{ kind: "buyKeeperProbeForMarket", shipSymbol: "X1-YARD|X1-A-A|X1-A-B" }],
      uncovered: ["X1-A-A", "X1-A-B"],
    });
    assert.deepEqual(v.upcoming, ["X1-A-B"], "only the market with no ask is still upcoming");
  });

  it("drops a market that was decided but not yet consumed, and keeps the other groups unchanged", async () => {
    const open = [{ kind: "buyShip", shipSymbol: "SHIP-1" }];
    const decided = [{ kind: "buyKeeperProbe", shipSymbol: "X1-YARD|X1-A-A|X1-A-B" }];
    const v = await setup({ open, decided, uncovered: ["X1-A-A", "X1-A-B"] });
    assert.deepEqual(v.upcoming, ["X1-A-B"]);
    assert.deepEqual(v.approvals, open);
    assert.deepEqual(v.decided, decided);
  });
});
