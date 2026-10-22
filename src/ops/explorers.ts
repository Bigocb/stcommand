/**
 * Data for the Explorers tab: gathers the explorer ships, the jumps they made, the survey marks and the keepers bought, and
 * hands them to the pure report builder (src/engine/explorerReport.ts). Read-only.
 */
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { buildExplorerReport, type ExplorerReport } from "../engine/explorerReport.js";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function explorerReport(w: TenantWorker, windowHours: number, nowMs: number): Promise<ExplorerReport> {
  const sinceIso = new Date(nowMs - windowHours * 3_600_000).toISOString();
  const explorers = w.fleet.explorerShips();
  const [moves, surveys, ledger, trades] = await Promise.all([
    w.store.opsMovements(w.tenantId, { kind: "jump", sinceIso, limit: 5000 }),
    w.store.recentSystemSurveys(w.tenantId, 400),
    w.store.opsLedger(w.tenantId, { type: "SHIP", sinceIso: new Date(nowMs - 720 * 3_600_000).toISOString(), limit: 2000 }),
    w.store.systemTradeSpans(w.tenantId),
  ]);
  return buildExplorerReport({
    nowIso: new Date(nowMs).toISOString(),
    windowHours,
    explorers,
    trades,
    jumps: moves.map((m) => ({ at: iso(m.at), ship: String(m.ship_symbol), from: String(m.from_waypoint ?? ""), to: String(m.to_waypoint ?? ""), cost: Number(m.cost ?? 0) })),
    surveys: surveys.map((s) => ({ system: s.systemSymbol, at: new Date(s.surveyedAt).toISOString(), markets: s.markets, shipyards: s.shipyards, source: s.source })),
    stations: w.fleet.keeperStations().map((k) => ({ ship: k.shipSymbol, market: k.market })),
    purchases: ledger.map((r) => ({ at: iso(r.timestamp), ship: String(r.ship_symbol), yard: String(r.waypoint_symbol ?? ""), hull: String(r.trade_symbol ?? ""), price: Number(r.total ?? 0) })),
  });
}
