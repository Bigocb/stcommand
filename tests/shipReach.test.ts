import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeShipReach, routeOutsideReach, systemOfWaypoint } from "../src/engine/shipReach.js";
import { reachSummaries } from "../src/engine/analysis/report.js";
import type { AnalysisLedgerRow } from "../src/db/store.js";

describe("ship reach", () => {
  it("defaults to any, and only accepts system or any", () => {
    assert.equal(normalizeShipReach(undefined), undefined);
    assert.equal(normalizeShipReach("any"), undefined);
    assert.equal(normalizeShipReach("system"), "system");
    assert.throws(() => normalizeShipReach("everywhere"), /reach must be/);
  });

  it("leaves an any-ship alone, whatever the route", () => {
    assert.equal(routeOutsideReach("any", "X1-A", { buySystem: "X1-B", sellSystem: "X1-C" }), undefined);
    assert.equal(routeOutsideReach(undefined, "X1-A", { buySystem: "X1-B" }), undefined);
  });

  it("keeps a local-only ship to routes that buy and sell in its own system", () => {
    assert.equal(routeOutsideReach("system", "X1-A", { buySystem: "X1-A", sellSystem: "X1-A" }), undefined);
    assert.match(routeOutsideReach("system", "X1-A", { buySystem: "X1-A", sellSystem: "X1-B" }) ?? "", /cannot sell in X1-B/);
    assert.match(routeOutsideReach("system", "X1-A", { buySystem: "X1-B", sellSystem: "X1-B" }) ?? "", /cannot buy in X1-B/);
  });

  it("refuses a local-only ship a route whose buy system is unknown, since it can't be shown to be local", () => {
    assert.ok(routeOutsideReach("system", "X1-A", { sellSystem: "X1-A" }));
    assert.ok(routeOutsideReach("system", undefined, { buySystem: "X1-A" }));
  });

  it("reads a system out of a waypoint symbol", () => {
    assert.equal(systemOfWaypoint("X1-CM13-A2"), "X1-CM13");
  });
});

describe("reach in the analysis", () => {
  const T0 = Date.parse("2026-10-15T00:00:00Z");
  const row = (h: number, ship: string, total: number): AnalysisLedgerRow => ({
    timestamp: new Date(T0 + h * 3_600_000).toISOString(), shipSymbol: ship, type: "SELL", good: "FOOD", waypoint: "X1-A-1",
    units: 40, pricePerUnit: total / 40, total, realizedPnl: total / 2, route: "X1-A-1>X1-A-2 auto",
  });

  it("splits trips and profit per hour between local-only and cross-system ships", () => {
    const ledger = [row(1, "LOCAL-1", 4000), row(2, "LOCAL-1", 4000), row(1.5, "CROSS-1", 8000)];
    const trips = ledger.map((r, i) => ({ shipSymbol: r.shipSymbol, good: "FOOD", buyAt: null, sellAt: "X1-A-2", source: null, startMs: Date.parse(r.timestamp) - 3_600_000, endMs: Date.parse(r.timestamp), unitsBought: 40, unitsSold: 40, cost: 0, revenue: r.total, realized: r.realizedPnl ?? 0, tripCosts: 0, positioningCosts: 0, partial: false, expectedProfit: null, correlationId: `t${i}` }));
    const split = reachSummaries(trips, ledger, new Set(["LOCAL-1"]), T0, T0 + 4 * 3_600_000);
    assert.equal(split.local.ships, 1);
    assert.equal(split.local.trips, 2);
    assert.equal(split.cross.ships, 1);
    assert.equal(split.cross.trips, 1);
    assert.equal(split.local.netProfit, 4000);
    assert.equal(split.cross.netProfit, 4000);
  });
});
