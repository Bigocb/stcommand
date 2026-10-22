import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * The seam where FleetManager uses keeperBuy.ts: a market that needs a keeper, in a system whose yard has stored probe
 * stock. No database: the store, approval gate and purchase are fakes, so this runs anywhere.
 */
const YARD = "X1-T-YARD";
const MARKET = "X1-T-M1";

function makeFleet(opts: { clauseOn: boolean; cap?: number; price?: number; shipsAtYard: { symbol: string; role: string; waypoint: string; nav: string }[] }) {
  const calls = { purchase: [] as unknown[][], approval: 0, dock: 0 };
  const fleet = new FleetManager({
    api: {
      getShip: async (s: string) => ({ symbol: s, nav: { status: "IN_ORBIT", waypointSymbol: YARD, systemSymbol: "X1-T" } }),
      dockShip: async () => { calls.dock++; },
    } as any,
  }) as any;
  fleet.tenantId = "t1";
  fleet.store = {
    shipyardInventory: async () => [{ systemSymbol: "X1-T", waypointSymbol: YARD, shipType: "SHIP_PROBE", purchasePrice: opts.price ?? 28_959, timestamp: new Date().toISOString() }],
    getUnconsumedApproval: async () => undefined,
    latestMarketSnapshots: async () => [],
  };
  fleet.doctrine = {
    isEnabledOr: (k: string) => (k === "autoApproveKeeperProbes" ? opts.clauseOn : true),
    value: (k: string, def?: number) => (k === "autoApproveKeeperProbes" ? opts.cap ?? 60_000 : def ?? 5),
  };
  fleet.approvals = { request: async () => { calls.approval++; return undefined; } };
  fleet.canAfford = () => true;
  fleet.keeperPriorityMarkets = async () => [MARKET];
  fleet.keeperTargetCovered = async () => false;
  fleet.otherKeeperKindTargets = async () => false;
  fleet.fleetStatusSummary = () => opts.shipsAtYard;
  fleet.purchaseKeeperProbe = async (...args: unknown[]) => { calls.purchase.push(args); };
  return { fleet, calls };
}

const keeperAtYard = [{ symbol: "K-1", role: "keeper", waypoint: YARD, nav: "IN_ORBIT" }];

describe("market keeper request with autoApproveKeeperProbes", () => {
  it("clause on, a ship at the yard: buys through it, raises no card, and ends the pass", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, shipsAtYard: keeperAtYard });
    const r = await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(r, true);
    assert.deepEqual(calls.purchase, [[YARD, MARKET, 28_959, "SHIP_PROBE"]]);
    assert.equal(calls.approval, 0, "no approval card");
    assert.equal(calls.dock, 1, "an orbiting ship is docked before the purchase");
  });

  it("clause on, nobody at the yard: no purchase, no card, and the queue is told to move on", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, shipsAtYard: [] });
    const r = await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(r, false, "false lets advanceKeeperMarketQueue try the next market");
    assert.deepEqual(calls.purchase, []);
    assert.equal(calls.approval, 0);
  });

  it("clause off: today's behaviour, an approval card and no purchase", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: false, shipsAtYard: keeperAtYard });
    await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(calls.approval, 1);
    assert.deepEqual(calls.purchase, []);
  });

  it("clause on but the quote is over the cap: asks the operator", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, cap: 20_000, shipsAtYard: keeperAtYard });
    await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(calls.approval, 1);
    assert.deepEqual(calls.purchase, []);
  });
});
