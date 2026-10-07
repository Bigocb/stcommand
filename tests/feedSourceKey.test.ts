import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedManager } from "../src/engine/feed.js";

/**
 * A buying feed and a mining feed may supply the same market with the same good (2026-10-07, operator: buy QUARTZ_SAND
 * at B7 and mine it at CE5D, both into F53). The source mode is part of a feed's identity.
 */

function manager(deleted: { good: string; mine?: boolean }[] = []) {
  return new FeedManager({
    api: { getShipCargo: async () => ({ inventory: [], capacity: 40, units: 0 }) } as any,
    getShip: async () => ({ symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-1" }, fuel: { capacity: 100, current: 100 }, cargo: { capacity: 40, units: 0, inventory: [] } }) as any,
    supplyAt: async () => "SCARCE",
    tenantId: "t-1",
    store: {
      latestFeeds: async () => [],
      recordFeed: async () => {},
      deleteFeed: async (_t: string, _wp: string, good: string, mine?: boolean) => { deleted.push({ good, mine }); },
    },
  } as any);
}

describe("feed source key", () => {
  it("runs a buying and a mining feed for the same good into the same market side by side", async () => {
    const fm = manager();
    await fm.start("X1-A-F53", "QUARTZ_SAND", { carrierTarget: 1, mine: false, buyAt: "X1-A-B7" });
    await fm.start("X1-A-F53", "QUARTZ_SAND", { carrierTarget: 2, mine: true });
    const feeds = (await fm.list()).filter((f) => f.good === "QUARTZ_SAND");
    assert.equal(feeds.length, 2);
    assert.deepEqual(feeds.map((f) => !!f.mine).sort(), [false, true]);
  });

  it("keeps a single feed addressable without saying which", async () => {
    const fm = manager();
    await fm.start("X1-A-F53", "IRON", { carrierTarget: 1 });
    await fm.setLimits("X1-A-F53", "IRON", { stopAtSupply: "HIGH" });
    assert.equal((await fm.list()).find((f) => f.good === "IRON")!.stopAtSupply, "HIGH");
  });

  it("refuses to guess between the two, and acts on exactly the one named", async () => {
    const fm = manager();
    await fm.start("X1-A-F53", "QUARTZ_SAND", { mine: false });
    await fm.start("X1-A-F53", "QUARTZ_SAND", { mine: true });
    await assert.rejects(fm.setLimits("X1-A-F53", "QUARTZ_SAND", { stopAtSupply: "HIGH" }), /both a buying and a mining feed/);
    await fm.setLimits("X1-A-F53", "QUARTZ_SAND", { stopAtSupply: "HIGH" }, true);
    const feeds = (await fm.list()).filter((f) => f.good === "QUARTZ_SAND");
    assert.equal(feeds.find((f) => f.mine)!.stopAtSupply, "HIGH");
    assert.equal(feeds.find((f) => !f.mine)!.stopAtSupply, undefined);
  });

  it("removes only the named feed, and the store deletes only that row", async () => {
    const deleted: { good: string; mine?: boolean }[] = [];
    const fm = manager(deleted);
    await fm.start("X1-A-F53", "QUARTZ_SAND", { mine: false });
    await fm.start("X1-A-F53", "QUARTZ_SAND", { mine: true });
    await fm.remove("X1-A-F53", "QUARTZ_SAND", false);
    const left = (await fm.list()).filter((f) => f.good === "QUARTZ_SAND");
    assert.equal(left.length, 1);
    assert.equal(left[0]!.mine, true);
    assert.deepEqual(deleted, [{ good: "QUARTZ_SAND", mine: false }]);
  });

  it("puts a carrier on the feed it was assigned to, not its twin", async () => {
    const fm = manager();
    await fm.start("X1-A-F53", "QUARTZ_SAND", { mine: false });
    await fm.start("X1-A-F53", "QUARTZ_SAND", { mine: true });
    await fm.assignCarrier("X1-A-F53", "QUARTZ_SAND", "DRONE-1", true);
    await fm.assignCarrier("X1-A-F53", "QUARTZ_SAND", "SHUTTLE-1", false);
    const feeds = (await fm.list()).filter((f) => f.good === "QUARTZ_SAND");
    assert.deepEqual(feeds.find((f) => f.mine)!.assignedShips, ["DRONE-1"]);
    assert.deepEqual(feeds.find((f) => !f.mine)!.assignedShips, ["SHUTTLE-1"]);
  });
});
