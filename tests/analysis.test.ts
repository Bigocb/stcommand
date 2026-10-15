import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActionEventRow, AnalysisLedgerRow, AnalysisSnapshotRow } from "../src/db/store.js";
import { rebuildTrips, summarizeRoutes, tripFindings, tripNet, tripNetAll } from "../src/engine/analysis/trips.js";
import { clusterTrades, impactFindings, latestTradeVolumes, summarizeImpact } from "../src/engine/analysis/marketImpact.js";
import { attributePriceMoves, moveFindings, summarizeMoves } from "../src/engine/analysis/priceMoves.js";
import { changeFindings, changeImpacts, windowMetrics } from "../src/engine/analysis/changes.js";
import { calibrate, predictProfit } from "../src/engine/analysis/calibration.js";
import { buildAnalysisReport, rankSuggestions } from "../src/engine/analysis/report.js";
import { DEFAULT_ANALYSIS_POLICY as P, confidenceFor, median } from "../src/engine/analysis/types.js";

const T0 = Date.parse("2026-10-15T00:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const row = (min: number, ship: string, type: string, good: string | null, waypoint: string | null, units: number, price: number, extra: Partial<AnalysisLedgerRow> = {}): AnalysisLedgerRow => ({
  timestamp: at(min), shipSymbol: ship, type, good, waypoint, units, pricePerUnit: price,
  total: type === "REFUEL" || type === "JUMP" ? price : units * price, realizedPnl: null, route: null, ...extra,
});
const snap = (min: number, waypoint: string, good: string, buy: number, sell: number, tradeVolume = 20): AnalysisSnapshotRow => ({
  timestamp: at(min), waypoint, good, purchasePrice: buy, sellPrice: sell, tradeVolume, supply: null, activity: null,
});
const planned = (min: number, ship: string, good: string, profit: number): ActionEventRow => ({
  at: at(min), universeKey: null, kind: "trip_planned", actor: "engine", shipSymbol: ship, good, correlationId: `trip:${ship}:${good}:${min}`, expected: { profit },
});

/** One trip: a jump before (positioning), buy 40 at 100, refuel mid-trip, sell 40 at 150 with realized pnl. */
function oneTrip(ship: string, start: number, sellPrice = 150, route = "X1-A-1>X1-A-2 auto"): AnalysisLedgerRow[] {
  return [
    row(start - 5, ship, "JUMP", null, null, 0, 5000),
    row(start, ship, "PURCHASE", "FOOD", "X1-A-1", 40, 100, { route }),
    row(start + 5, ship, "REFUEL", null, null, 0, 300),
    row(start + 10, ship, "SELL", "FOOD", "X1-A-2", 40, sellPrice, { route, realizedPnl: 40 * (sellPrice - 100) }),
  ];
}

describe("trips", () => {
  it("rebuilds a trip with its own costs and the positioning before it", () => {
    const [t] = rebuildTrips(oneTrip("S-1", 10));
    assert.equal(t!.buyAt, "X1-A-1");
    assert.equal(t!.sellAt, "X1-A-2");
    assert.equal(t!.source, "auto");
    assert.equal(t!.realized, 2000);
    assert.equal(t!.tripCosts, 300);
    assert.equal(t!.positioningCosts, 5000);
    assert.equal(tripNet(t!), 1700);
    assert.equal(tripNetAll(t!), -3300);
    assert.equal(t!.endMs, T0 + 20 * 60_000);
  });

  it("joins the estimate from a trip_planned event within two minutes of the first purchase", () => {
    const [t] = rebuildTrips(oneTrip("S-1", 10), [planned(11, "S-1", "FOOD", 2500), planned(40, "S-1", "FOOD", 9999)]);
    assert.equal(t!.expectedProfit, 2500);
    assert.equal(t!.correlationId, "trip:S-1:FOOD:11");
  });

  it("marks a trip whose purchases are before the window as partial, and keeps it out of route stats", () => {
    const trips = rebuildTrips([row(0, "S-1", "SELL", "FOOD", "X1-A-2", 40, 150, { realizedPnl: 500 })]);
    assert.equal(trips[0]!.partial, true);
    assert.equal(summarizeRoutes(trips).length, 0);
  });

  it("calls a route that made money on most trips a success, and one that lost money a failure", () => {
    const win = [0, 30, 60].flatMap((m) => oneTrip("S-1", m + 10, 300).slice(1)); // no positioning jumps
    const lose = [0, 30, 60].flatMap((m) => oneTrip("S-2", m + 10, 90, "X1-B-1>X1-B-2 auto").slice(1));
    const routes = summarizeRoutes(rebuildTrips([...win, ...lose].sort((a, b) => a.timestamp.localeCompare(b.timestamp))));
    const kinds = tripFindings(routes, P).map((f) => `${f.kind}:${f.subject}`);
    assert.ok(kinds.includes("worked:FOOD X1-A-1>X1-A-2"));
    assert.ok(kinds.includes("didnt_work:FOOD X1-B-1>X1-B-2"));
  });

  it("flags a route whose estimates are consistently too optimistic", () => {
    const rows = [0, 30, 60].flatMap((m) => oneTrip("S-1", m + 10, 150).slice(1));
    const events = [0, 30, 60].map((m) => planned(m + 10, "S-1", "FOOD", 5000)); // actual 1700 each
    const routes = summarizeRoutes(rebuildTrips(rows, events));
    assert.equal(routes[0]!.actualVsExpected, 0.34);
    const f = tripFindings(routes, P).find((x) => x.kind === "estimate")!;
    assert.match(f.headline, /34% of its estimate.*too optimistic/);
  });

  it("flags a route where positioning eats most of the profit, with the doctrine knob to turn", () => {
    const rows = [0, 30, 60].flatMap((m) => oneTrip("S-1", m + 10, 250));
    const f = tripFindings(summarizeRoutes(rebuildTrips(rows)), P).find((x) => x.kind === "cost")!;
    assert.equal(f.suggestion!.tool, "stcommand_set_doctrine");
    assert.deepEqual(f.suggestion!.args, { key: "positioningHops", value: 3 });
  });
});

describe("market impact", () => {
  // THEOREM-55's run at X1-KQ90-E25F on 2026-10-14: 100-unit lots, price 6784 -> 6092 across the run.
  const sells = [6784, 6763, 6643, 6496, 6315, 6092].map((p, i) => row(i * 0.1, "S-55", "SELL", "ADVANCED_CIRCUITRY", "X1-KQ90-E25F", 100, p));
  const snaps = [snap(-10, "X1-KQ90-E25F", "ADVANCED_CIRCUITRY", 4000, 6800, 100), snap(30, "X1-KQ90-E25F", "ADVANCED_CIRCUITRY", 4000, 6200, 100), snap(90, "X1-KQ90-E25F", "ADVANCED_CIRCUITRY", 4000, 6750, 100)];

  it("measures the move per lot from our own fill prices and the recovery from the snapshots", () => {
    const [c] = clusterTrades(sells, snaps, P, T0 + 120 * 60_000);
    assert.equal(c!.lots, 6);
    assert.equal(c!.side, "sell");
    // (6784 - 6092) / 6784 = 10.2% over 5 lots after the first = 2.04% a lot.
    assert.equal(c!.impactPerLot, 0.0204);
    assert.equal(c!.recoveryMinutes, 90);
    assert.equal(c!.censored, false);
  });

  it("marks a market that hasn't come back as not recovered", () => {
    const [c] = clusterTrades(sells, snaps.slice(0, 2), P, T0 + 120 * 60_000);
    assert.equal(c!.censored, true);
  });

  it("flags heavy impact against the model, suggesting a lot cap at half the trade volume", () => {
    // 1000 -> 800 over two 20-unit lots after the first: 10% a lot, against the model's 4.5% (heavy above 6.75%).
    const heavy = [0, 30].flatMap((m) => [1000, 900, 800].map((p, i) => row(m + i * 0.1, "S-1", "SELL", "G", "X1-A-1", 20, p)));
    const s = summarizeImpact(clusterTrades(heavy, [snap(-5, "X1-A-1", "G", 500, 1000, 20)], P, T0));
    assert.equal(s[0]!.medianImpactPerLot, 0.1);
    const f = impactFindings(s, P, latestTradeVolumes([snap(-5, "X1-A-1", "G", 500, 1000, 20)])).find((x) => x.kind === "market_impact")!;
    assert.deepEqual(f.suggestion!.args, { shipSymbol: "S-1", lotSize: 10 });
  });
});

describe("price moves", () => {
  const snaps = [snap(0, "M", "G", 100, 90), snap(10, "M", "G", 120, 90), snap(20, "M", "G", 120, 70), snap(30, "M", "G", 140, 70), snap(40, "M", "G", 141, 70)];
  const ours = [row(5, "US-1", "PURCHASE", "G", "M", 10, 105)];
  const theirs = [{ timestamp: at(15), waypoint: "M", good: "G", shipSymbol: "RIVAL-1", type: "SELL", units: 10 }];

  it("attributes each big move to us, another agent, or nobody seen, and ignores small ones", () => {
    const moves = attributePriceMoves(snaps, ours, theirs, new Set(["US-1"]), P);
    assert.deepEqual(moves.map((m) => m.cause), ["ours", "others", "unexplained"]);
    assert.deepEqual(moves[1]!.otherShips, ["RIVAL-1"]);
  });

  it("does not count our own ships in the market log as competition", () => {
    const moves = attributePriceMoves(snaps.slice(0, 2), [], [{ ...theirs[0]!, timestamp: at(5), shipSymbol: "US-1" }], new Set(["US-1"]), P);
    assert.equal(moves[0]!.cause, "unexplained");
  });

  it("reports a market where we cause most moves", () => {
    const f = moveFindings(summarizeMoves([1, 2, 3].map((i) => ({ waypoint: "M", good: "G", fromMs: i, toMs: i + 1, change: 0.1, cause: "ours" as const, otherShips: [] }))));
    assert.equal(f[0]!.kind, "price_moves");
  });
});

describe("settings changes", () => {
  const change: ActionEventRow = { at: at(360), universeKey: null, kind: "config_change", actor: "operator", subject: "doctrine:maxLotsPerTrip", context: { before: { value: 6, enabled: true }, after: { value: 3, enabled: true } } };
  // 4 good trips in the 6h before, 4 poor ones in the 6h after (after a 15 min settle).
  const before = [60, 120, 180, 240].flatMap((m) => oneTrip("S-1", m, 300).slice(1));
  const after = [400, 460, 520, 580].flatMap((m) => oneTrip("S-1", m, 120).slice(1));
  const rows = [...before, ...after];

  it("compares profit per hour before and after, and suggests putting a doctrine value back when it fell", () => {
    const impacts = changeImpacts([change], rebuildTrips(rows), rows, P, T0 + 24 * 3_600_000);
    assert.equal(impacts[0]!.windowBefore.trips, 4);
    assert.equal(impacts[0]!.windowAfter!.trips, 4);
    assert.ok(impacts[0]!.profitPerHourChange! < 0);
    const f = changeFindings(impacts, P)[0]!;
    assert.match(f.headline, /went down.*correlation, not proof/);
    assert.deepEqual(f.suggestion!.args, { key: "maxLotsPerTrip", value: 6, enabled: true });
  });

  it("gives no verdict on a change whose after-window hasn't happened yet", () => {
    const impacts = changeImpacts([change], rebuildTrips(rows), rows, P, T0 + 400 * 60_000);
    assert.equal(impacts[0]!.tooRecent, true);
    assert.equal(changeFindings(impacts, P).length, 0);
  });

  it("measures overhead as refuel and jump spend over sales", () => {
    const m = windowMetrics([], oneTrip("S-1", 10), T0, T0 + 60 * 60_000);
    assert.equal(m.overheadShare, 0.8833); // 5300 / 6000, to four places
  });
});

describe("calibration", () => {
  it("shrinks a small route's factor toward the fleet's and predicts from the most specific basis", () => {
    const rows = [...[0, 30, 60].flatMap((m) => oneTrip("S-1", m + 10, 150).slice(1)), ...oneTrip("S-2", 200, 150, "X1-C-1>X1-C-2 auto").slice(1)];
    const events = [planned(10, "S-1", "FOOD", 1700), planned(40, "S-1", "FOOD", 1700), planned(70, "S-1", "FOOD", 1700), planned(200, "S-2", "FOOD", 3400)];
    const c = calibrate(rebuildTrips(rows, events), P);
    assert.equal(c.fleet.trips, 4);
    assert.equal(c.fleet.factor, 0.8); // 6800 / 8500
    const small = c.routes.find((r) => r.key === "FOOD X1-C-1>X1-C-2")!;
    assert.equal(small.rawFactor, 0.5);
    assert.equal(small.factor, 0.73); // (1 x 0.5 + 3 x 0.8) / 4 = 0.725
    assert.deepEqual(predictProfit(c, 10_000, "FOOD", "X1-C-1>X1-C-2"), { predicted: 7300, factor: 0.73, basis: "route, 1 trips" });
    assert.equal(predictProfit(c, 10_000, "IRON").basis, "fleet, 4 trips");
  });
});

describe("report", () => {
  it("runs every module over one window and ranks suggestions without duplicates", () => {
    const rows = [0, 30, 60].flatMap((m) => oneTrip("S-1", m + 10, 250));
    const r = buildAnalysisReport({ fromMs: T0, nowMs: T0 + 6 * 3_600_000, ledger: rows, events: [], snapshots: [], marketTrades: [], ourShips: new Set(["S-1"]) });
    assert.equal(r.summary.trips, 3);
    assert.equal(r.summary.tripsWithEstimate, 0);
    assert.ok(r.notes.some((n) => /No trip in this window has a recorded estimate/.test(n)));
    assert.ok(r.findings.some((f) => f.kind === "cost"));
    assert.equal(r.suggestions.length, new Set(r.suggestions.map((s) => s.findingId)).size);
  });

  it("ranks suggestions by credits at stake", () => {
    const f = (id: string, weight: number) => ({ id, kind: "cost" as const, subject: id, headline: id, evidence: {}, sampleSize: 3, confidence: "low" as const, weight, suggestion: { action: id, why: "x" } });
    assert.deepEqual(rankSuggestions([f("a", 1), f("b", 9)]).map((s) => s.findingId), ["b", "a"]);
  });

  it("helpers: confidence from sample size, median", () => {
    assert.equal(confidenceFor(2), "low");
    assert.equal(confidenceFor(5), "medium");
    assert.equal(confidenceFor(12), "high");
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([]), null);
  });
});
