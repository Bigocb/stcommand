/**
 * Fetch the rows the analysis engine needs and build the report (src/engine/analysis/report.ts). Shared by the ops
 * `analysis` tool and the MCP capture tool, so a saved report is exactly what the read tool shows.
 */
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { buildAnalysisReport, type AnalysisReport } from "../engine/analysis/report.js";

export async function runAnalysis(w: TenantWorker, sinceHours: number, nowMs: number): Promise<AnalysisReport> {
  const fromMs = nowMs - sinceHours * 3_600_000;
  // A trip that closes in the window may have started before it, and a change's before-window reaches back further.
  const lookbackMs = 6 * 3_600_000;
  const sinceIso = new Date(fromMs - lookbackMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const [ledger, events] = await Promise.all([
    w.store.analysisLedgerRows(w.tenantId, sinceIso),
    w.store.actionEvents(w.tenantId, { sinceIso }),
  ]);
  const pairs = new Map<string, { waypoint: string; good: string }>();
  for (const r of ledger) {
    if ((r.type === "PURCHASE" || r.type === "SELL") && r.good && r.waypoint) pairs.set(`${r.waypoint}|${r.good}`, { waypoint: r.waypoint, good: r.good });
  }
  const pairList = [...pairs.values()];
  const [snapshots, marketTrades] = await Promise.all([
    w.store.analysisSnapshots(pairList, sinceIso, nowIso),
    w.store.analysisMarketTransactions(pairList, sinceIso, nowIso),
  ]);
  const ourShips = new Set<string>([...w.fleet.fleetStatusSummary().map((s) => s.symbol), ...ledger.map((r) => r.shipSymbol)]);
  return buildAnalysisReport({ fromMs, nowMs, ledger, events, snapshots, marketTrades, ourShips });
}
