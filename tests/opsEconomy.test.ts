import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buyPreflight, economyReport, type EconomyDeps } from "../src/ops/economy.js";

/**
 * The thin source behind ops economy_health, GET /api/fleet/buy/preflight, POST /fleet/buy and the MCP buy_ship reply
 * (src/ops/economy.ts), with the store and fleet faked: the 2026-11-17 22:11 heavy buy, with THEO-A1 bought at 19:24.
 */

const T = (iso: string) => Date.parse(iso);
const NOW = T("2026-11-17T22:11:00Z");

function deps(over: { doctrineOff?: string[] } = {}): EconomyDeps {
  const traders = [
    { symbol: "THEO-A1", role: "trader", cargoCap: 480 },
    ...Array.from({ length: 10 }, (_, i) => ({ symbol: `THEO-${i + 2}`, role: "trader", cargoCap: i < 4 ? 40 : 80 })),
    { symbol: "THEO-K1", role: "keeper", cargoCap: 0 },
  ];
  const ledger = [
    { ts: T("2026-11-17T19:24:00Z"), ship: "THEO-A1", waypoint: "X1-YN91-A2", type: "SHIP", good: "SHIP_HEAVY_FREIGHTER", units: 0, total: 2_240_596, pnl: null, wallet: 957_000, pricePerUnit: null, contractId: null },
    { ts: T("2026-11-17T20:30:00Z"), ship: "THEO-A1", waypoint: "X1-YN91-B1", type: "SELL", good: "MEDICINE", units: 400, total: 1_600_000, pnl: 940_000, wallet: 2_500_000, pricePerUnit: 4_000, contractId: null },
    { ts: T("2026-11-17T21:40:00Z"), ship: "THEO-A1", waypoint: "X1-YN91-B1", type: "SELL", good: "MEDICINE", units: 400, total: 1_400_000, pnl: 560_000, wallet: 2_930_000, pricePerUnit: 3_500, contractId: null },
  ];
  const off = new Set(over.doctrineOff ?? []);
  return {
    tenantId: "t1",
    store: {
      ledgerRowsSince: async () => ledger,
      wealthSamplesSince: async () => [],
      shipyardInventory: async () => [{ systemSymbol: "X1-YN91", waypointSymbol: "X1-YN91-A2", shipType: "SHIP_HEAVY_FREIGHTER", purchasePrice: 2_303_936, cargoCapacity: 480 } as never],
    },
    fleet: {
      fleetStatusSummary: () => traders as never,
      cargoValues: async () => ({}),
      walletCredits: () => 2_930_000,
      idleTraders: () => [],
      economyQueueFacts: () => ({ lastReleaseAt: T("2026-11-17T21:30:00Z"), staged: ["X1-RS9"], tourShips: 2, tourShipsFree: 1 }),
      doctrine: { value: (_k: string, d?: number) => d as number, isEnabledOr: (k: string) => !off.has(k) } as never,
    },
  };
}

describe("ops economy source: buy preflight", () => {
  it("the 22:11 heavy buy warns on the floor, the 10M line and payback, from the cached price and the ledger", async () => {
    const p = await buyPreflight(deps(), "SHIP_HEAVY_FREIGHTER", "X1-YN91-A2", NOW);
    assert.equal(p.price, 2_303_936);
    assert.equal(p.cargo, 480);
    assert.equal(p.ok, false);
    assert.equal(p.floor, 1_800_000, "2 heavies x 400k + 10 other traders x 100k (the keeper is not a trader)");
    assert.ok(p.warnings.some((w) => w.includes("working-capital floor")), p.warnings.join(" | "));
    assert.ok(p.warnings.some((w) => w.includes("10M line")), p.warnings.join(" | "));
    assert.ok(p.warnings.some((w) => w.startsWith("THEO-A1, the last big hull (2.24M, 2.8 h ago), has made 1.5M matched profit")), p.warnings.join(" | "));
  });

  it("an unknown yard price says so", async () => {
    const p = await buyPreflight(deps(), "SHIP_LIGHT_HAULER", "X1-YN91-A2", NOW);
    assert.equal(p.price, null);
    assert.match(p.warnings[0]!, /^No price on file for SHIP_LIGHT_HAULER at X1-YN91-A2/);
  });

  it("clause buyAdvice off: no warnings", async () => {
    const p = await buyPreflight(deps({ doctrineOff: ["buyAdvice"] }), "SHIP_HEAVY_FREIGHTER", "X1-YN91-A2", NOW);
    assert.deepEqual(p.warnings, []);
    assert.equal(p.ok, true);
  });
});

describe("ops economy source: economy_health", () => {
  it("reports the summary it judged on", async () => {
    const r = await economyReport(deps(), NOW);
    assert.equal(r.on, true);
    assert.equal(r.summary.traders, 11);
    assert.equal(r.summary.bigHulls, 1);
    assert.equal(r.summary.floor, 400_000 + 10 * 100_000);
    assert.equal(r.summary.staged, 1);
    assert.ok(Array.isArray(r.findings));
  });

  it("clause economyAlerts off: no findings", async () => {
    const r = await economyReport(deps({ doctrineOff: ["economyAlerts"] }), NOW);
    assert.equal(r.on, false);
    assert.deepEqual(r.findings, []);
  });
});
