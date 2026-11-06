import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

// buyKeeperThroughPresentShip against a stand-in `this`: the live yard price is read before a keeper hull is bought.
function fake(opts: { livePrice: number | "fail"; cap: number }) {
  const bought: string[] = [];
  const logs: string[] = [];
  const cooled: string[] = [];
  const self: any = {
    fleetStatusSummary: () => [{ symbol: "K1", waypoint: "X1-AB-YARD", nav: "DOCKED", role: "keeper" }],
    api: {
      getShip: async () => ({ nav: { waypointSymbol: "X1-AB-YARD", status: "DOCKED" } }),
      dockShip: async () => {},
      getShipyard: async () => { if (opts.livePrice === "fail") throw new Error("503"); return { ships: [{ type: "SHIP_PROBE", purchasePrice: opts.livePrice }] }; },
    },
    keeperYardPaid: new Map<string, { price: number; at: number }>(),
    keeperAutoApproves: (price: number) => ({ approve: price <= opts.cap, reason: `${price}c vs ${opts.cap}c` }),
    purchaseKeeperProbe: async () => { bought.push("probe"); return "bought"; },
    coolKeeperMarket: async (m: string) => { cooled.push(m); },
    log: (m: string) => logs.push(m),
  };
  return { self, bought, logs, cooled };
}
const run = (self: any, stored = 42_089) => (FleetManager.prototype as any).buyKeeperThroughPresentShip.call(self, "X1-AB-YARD", "X1-CD-M1", stored, "SHIP_PROBE");

describe("keeper purchase reads the live yard price first", () => {
  it("does not buy when the live price is over the auto-approve cap, remembers it and holds the market back", async () => {
    const { self, bought, logs, cooled } = fake({ livePrice: 81_470, cap: 60_000 });
    assert.equal(await run(self), "failed");
    assert.deepEqual(bought, []);
    assert.equal(self.keeperYardPaid.get("X1-AB-YARD|SHIP_PROBE").price, 81_470);
    assert.deepEqual(cooled, ["X1-CD-M1"]);
    assert.match(logs[0]!, /live price 81470 is over the auto-approve cap \(stored reading 42089\)/);
  });
  it("buys when the live price is within the cap", async () => {
    const { self, bought } = fake({ livePrice: 45_000, cap: 60_000 });
    assert.equal(await run(self), "bought");
    assert.deepEqual(bought, ["probe"]);
  });
  it("falls back to the stored reading when the live read fails", async () => {
    const { self, bought } = fake({ livePrice: "fail", cap: 60_000 });
    assert.equal(await run(self), "bought");
    assert.deepEqual(bought, ["probe"]);
  });
});
