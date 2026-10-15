import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAnalysis } from "../src/ops/analysis.js";
import { OPS_TOOLS } from "../src/ops/catalog.js";

/** The seam: the ops tool fetches the rows the engine needs, for the markets we traded, and builds the report. */
describe("runAnalysis", () => {
  it("asks for snapshots and market trades only for the markets we traded, and reports on them", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const t = (min: number) => new Date(now - 120 * 60_000 + min * 60_000).toISOString();
    const asked: unknown[] = [];
    const w = {
      tenantId: "t1",
      store: {
        analysisLedgerRows: async () => [
          { timestamp: t(0), shipSymbol: "S-1", type: "PURCHASE", good: "FOOD", waypoint: "X1-A-1", units: 40, pricePerUnit: 100, total: 4000, realizedPnl: null, route: "X1-A-1>X1-A-2 auto" },
          { timestamp: t(10), shipSymbol: "S-1", type: "SELL", good: "FOOD", waypoint: "X1-A-2", units: 40, pricePerUnit: 150, total: 6000, realizedPnl: 2000, route: "X1-A-1>X1-A-2 auto" },
        ],
        actionEvents: async () => [],
        analysisSnapshots: async (pairs: unknown) => { asked.push(pairs); return []; },
        analysisMarketTransactions: async () => [],
      },
      fleet: { fleetStatusSummary: () => [{ symbol: "S-1" }] },
    } as any;
    const r = await runAnalysis(w, 6, now);
    assert.deepEqual(asked[0], [{ waypoint: "X1-A-1", good: "FOOD" }, { waypoint: "X1-A-2", good: "FOOD" }]);
    assert.equal(r.summary.trips, 1);
    assert.equal(r.summary.netProfit, 2000);
  });

  it("is registered as an ops tool, with the saved-report reader beside it", () => {
    const names = OPS_TOOLS.map((x) => x.name);
    assert.ok(names.includes("analysis"));
    assert.ok(names.includes("findings_history"));
  });
});
