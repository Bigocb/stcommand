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
  const [snapshots, marketTrades, wealthRows, shipRows] = await Promise.all([
    w.store.analysisSnapshots(pairList, sinceIso, nowIso),
    w.store.analysisMarketTransactions(pairList, sinceIso, nowIso),
    w.store.wealthSamplesSince(w.tenantId, new Date(fromMs).toISOString()),
    w.store.shipLedgerRows(w.tenantId, new Date(0).toISOString()),
  ]);
  const hullEvents = shipRows.map((r) => ({ ts: Date.parse(r.timestamp), amount: r.scrap ? -r.total : r.total }));
  const ourShips = new Set<string>([...w.fleet.fleetStatusSummary().map((s) => s.symbol), ...ledger.map((r) => r.shipSymbol)]);
  const localShips = new Set(w.fleet.shipReachList().map((e) => e.shipSymbol));
  return buildAnalysisReport({ fromMs, nowMs, ledger, events, snapshots, marketTrades, ourShips, wealth: wealthRows, hullEvents, localShips });
}

/**
 * The same report, reused for up to `ttlMs` per tenant and window. The Season screen and the Tower card read it on
 * every open; one build reads the ledger, snapshots and market trades, so a burst of page loads shouldn't repeat it.
 */
const cache = new Map<string, { at: number; report: AnalysisReport }>();

export async function runAnalysisCached(w: TenantWorker, sinceHours: number, nowMs: number, ttlMs = 60_000): Promise<AnalysisReport> {
  const hours = Math.round(sinceHours * 4) / 4; // quarter hours, so a window that grows by seconds still hits the cache
  const key = `${w.tenantId}|${hours}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < ttlMs) return hit.report;
  const report = await runAnalysis(w, hours, nowMs);
  cache.set(key, { at: nowMs, report });
  if (cache.size > 200) {
    for (const [k, v] of cache) if (nowMs - v.at >= ttlMs) cache.delete(k);
  }
  return report;
}
