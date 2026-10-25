import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-10-25: the reset wind-down no longer scraps hulls (operator: complex, small return; 6 of 316 sent in 70 minutes). It only
 * blocks new buys and lets ships sell what they hold. The retirement code stays behind FleetManager.WIND_DOWN_SCRAP for later.
 */
describe("the wind-down does not scrap ships", () => {
  afterEach(() => { FleetManager.WIND_DOWN_SCRAP = false; });

  function fleet() {
    const f = new FleetManager({ api: { onMarket: () => {} } as any });
    const sold: string[] = [];
    (f as any).windDownState = () => ({ active: true, reason: "test" });
    (f as any).getShipStatuses = () => [{ symbol: "K-1", role: "keeper" }, { symbol: "T-1", role: "trader" }];
    (f as any).shipFor = () => ({ cargo: { units: 0 } });
    (f as any).sellShip = async (s: string) => { sold.push(s); return "X1-A-A2"; };
    return { f, sold };
  }

  it("sends nothing to a yard while the window is open, and empties the queue", async () => {
    const { f, sold } = fleet();
    (f as any).retireQueue.add("K-1");
    await (f as any).retireNonTraders();
    assert.deepEqual(sold, []);
    assert.equal((f as any).retireQueue.size, 0);
  });

  it("still retires when the switch is turned on (the code is kept)", async () => {
    FleetManager.WIND_DOWN_SCRAP = true;
    const { f, sold } = fleet();
    await (f as any).retireNonTraders();
    assert.ok(sold.includes("K-1"), `expected the keeper to be sent, got ${JSON.stringify(sold)}`);
  });
});
