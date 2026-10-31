import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { SystemQueue } from "../src/engine/systemQueue.js";

/**
 * 2026-10-31: 18 markets in three systems nothing could be bought for were retried on every pass, each time reading the whole shipyard table
 * (30 s a pass). A market with no yard or no ship is now held back, and an unreachable staged system goes back to scouted with its markets
 * off the keeper list. No database: the store and the galaxy are fakes.
 */
const MARKET = "X1-NOYARD-M1";

function makeFleet() {
  const reads = { yards: 0 };
  const fleet = new FleetManager({ api: {} as any }) as any;
  fleet.tenantId = "t1";
  fleet.store = {
    shipyardInventory: async () => { reads.yards++; return []; },
    latestMarketSnapshots: async () => [],
    getUnconsumedApproval: async () => undefined,
    getFleetFlag: async () => undefined,
    setFleetFlag: async () => {},
  };
  fleet.doctrine = { isEnabledOr: () => true, value: (_k: string, d?: number) => d ?? 5 };
  fleet.galaxy = { allPositions: () => [], jumpPath: () => undefined };
  fleet.fleetStatusSummary = () => [];
  fleet.log = () => {};
  fleet.keeperPriorityMarkets = async () => [MARKET];
  const book = { queueCooldown: new Map<string, number>(), yardWait: new Map(), surveyRetry: new Map(), topUp: new Map() };
  fleet.timers = () => ({ load: async () => {}, save: async () => {}, book });
  fleet.timersDoc = { book };
  return { fleet, reads, book };
}

describe("keeper queue holds back what cannot be bought", () => {
  it("a market with no keeper hull anywhere in reach is skipped for 15 minutes, so the next pass does not read the yards again", async () => {
    const { fleet, reads, book } = makeFleet();
    assert.equal(await fleet.maybeRequestKeeperProbeForMarket(MARKET), false);
    assert.ok((book.queueCooldown.get(MARKET) ?? 0) > Date.now() + 14 * 60_000);
    const before = reads.yards;
    assert.equal(await fleet.maybeRequestKeeperProbeForMarket(MARKET), false);
    assert.equal(reads.yards, before, "the second request returns before touching the store");
  });
});

describe("unstageSystem", () => {
  it("returns the system to scouted and takes its unbought markets off the keeper list, keeping one that has a keeper", async () => {
    const { fleet } = makeFleet();
    const queue = new SystemQueue();
    queue.scout("X1-NOGATE", ["X1-NOGATE-A", "X1-NOGATE-B"], 1);
    queue.stage("X1-NOGATE", 2);
    fleet.systemQueue = queue;
    let list = ["X1-OTHER-1", "X1-NOGATE-A", "X1-NOGATE-B"];
    fleet.keeperPriorityMarkets = async () => list;
    fleet.setKeeperPriorityMarkets = async (m: string[]) => { list = m; return m; };
    fleet.coveredKeeperMarkets = () => new Set(["X1-NOGATE-B"]);
    fleet.saveFreshGate = async () => {};
    fleet.freshNote = () => {};
    fleet.recordAction = () => {};
    await fleet.unstageSystem("X1-NOGATE", "no finished gate path");
    assert.equal(queue.get("X1-NOGATE")!.state, "scouted");
    assert.deepEqual(list, ["X1-OTHER-1", "X1-NOGATE-B"]);
  });
});
