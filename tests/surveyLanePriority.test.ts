import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { API_PRIORITY, currentApiPriority, runWithApiPriority } from "../src/core/client.js";

/**
 * 2026-11-25: the arrival survey's market and shipyard sweeps inherited the calling ship's task priority, so keeper probes hopping out
 * to new systems sent 20-30 market reads a system through the box's IP. The sweeps now run at deferrable priority, which the proxy lane
 * takes (apiLanes.ts chooseLane: GET at priority 3 or lower urgency).
 */
describe("surveySystem runs its read-only sweeps at deferrable priority", () => {
  it("market and shipyard sweeps see DEFERRABLE even when the caller is critical", async () => {
    const seen: Record<string, number | undefined> = {};
    const self: any = {
      galaxy: {
        loadSystem: async () => ({}),
        getSystem: () => ({ waypoints: [{ symbol: "X1-AA-1", traits: [] }] }),
        scanJumpGates: async () => {},
        surveyMarkets: async () => { seen.markets = currentApiPriority(); return []; },
        surveyShipyards: async () => { seen.yards = currentApiPriority(); return []; },
        allPositions: () => [],
      },
      refreshTraitsIfEmpty: async () => {},
      log: () => {},
      markets: [],
      registry: { recordMarkets: () => {}, noteTopologyChanged: () => {} },
      store: undefined,
      markSystemSurveyed: async () => {},
    };
    await runWithApiPriority(API_PRIORITY.CRITICAL, () => (FleetManager.prototype as any).surveySystem.call(self, "X1-AA"));
    assert.equal(seen.markets, API_PRIORITY.DEFERRABLE);
    assert.equal(seen.yards, API_PRIORITY.DEFERRABLE);
  });
});
