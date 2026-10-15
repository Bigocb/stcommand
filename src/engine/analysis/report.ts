/**
 * The analysis report: every module run over one window and ranked together (docs/analysis-engine.md).
 *
 * Pure: the caller (src/ops/analysis.ts) fetches the rows and passes `nowMs`. The report is bounded in size so it can
 * be read over MCP, and it is what gets saved to analysis_findings at the end of a week.
 */
import type { ActionEventRow, AnalysisLedgerRow, AnalysisSnapshotRow } from "../../db/store.js";
import { calibrate, type Calibration } from "./calibration.js";
import { changeFindings, changeImpacts, windowMetrics, type ChangeImpact } from "./changes.js";
import { clusterTrades, impactFindings, latestTradeVolumes, summarizeImpact, type MarketImpactStat } from "./marketImpact.js";
import { attributePriceMoves, moveFindings, summarizeMoves, type MarketTrade, type MoveStats } from "./priceMoves.js";
import { rebuildTrips, summarizeRoutes, tripFindings, tripNetAll, type RouteStats } from "./trips.js";
import { DEFAULT_ANALYSIS_POLICY, round2, type AnalysisPolicy, type Finding, type Suggestion } from "./types.js";

export interface AnalysisInputs {
  fromMs: number;
  nowMs: number;
  ledger: readonly AnalysisLedgerRow[];
  events: readonly ActionEventRow[];
  snapshots: readonly AnalysisSnapshotRow[];
  marketTrades: readonly MarketTrade[];
  ourShips: ReadonlySet<string>;
}

export interface RankedSuggestion extends Suggestion {
  findingId: string;
  weight: number;
  confidence: Finding["confidence"];
}

export interface AnalysisReport {
  window: { from: string; to: string; hours: number };
  summary: {
    trips: number;
    netProfit: number;
    profitPerHour: number;
    overheadShare: number | null;
    positioningCosts: number;
    tripsWithEstimate: number;
    configChanges: number;
    priceMovesAttributed: number;
  };
  findings: Finding[];
  suggestions: RankedSuggestion[];
  routes: { best: RouteStats[]; worst: RouteStats[] };
  markets: MarketImpactStat[];
  priceMoves: MoveStats[];
  changes: ChangeImpact[];
  calibration: Calibration;
  notes: string[];
}

const LIMIT = 12;

/** Suggestions from the findings that carry one, ranked by credits at stake and then confidence, one per action. */
export function rankSuggestions(findings: readonly Finding[]): RankedSuggestion[] {
  const rank = { high: 3, medium: 2, low: 1 } as const;
  const seen = new Set<string>();
  return findings
    .filter((f) => f.suggestion)
    .sort((a, b) => b.weight - a.weight || rank[b.confidence] - rank[a.confidence])
    .filter((f) => {
      const key = `${f.suggestion!.tool ?? ""}|${JSON.stringify(f.suggestion!.args ?? {})}|${f.suggestion!.action}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((f) => ({ ...f.suggestion!, findingId: f.id, weight: f.weight, confidence: f.confidence }));
}

export function buildAnalysisReport(input: AnalysisInputs, policy: AnalysisPolicy = DEFAULT_ANALYSIS_POLICY): AnalysisReport {
  const ledger = input.ledger.filter((r) => Date.parse(r.timestamp) >= input.fromMs);
  const trips = rebuildTrips(ledger, input.events);
  const closed = trips.filter((t) => t.endMs !== null && !t.partial);
  const routes = summarizeRoutes(trips);
  const clusters = clusterTrades(ledger, input.snapshots, policy, input.nowMs);
  const impact = summarizeImpact(clusters);
  const moves = attributePriceMoves(input.snapshots.filter((s) => Date.parse(s.timestamp) >= input.fromMs), ledger, input.marketTrades, input.ourShips, policy);
  const moveStats = summarizeMoves(moves);
  const changes = changeImpacts(input.events.filter((e) => Date.parse(e.at) >= input.fromMs), trips, ledger, policy, input.nowMs);
  const calibration = calibrate(trips, policy);
  const whole = windowMetrics(trips, ledger, input.fromMs, input.nowMs);

  const findings = [
    ...tripFindings(routes, policy),
    ...impactFindings(impact, policy, latestTradeVolumes(input.snapshots)),
    ...moveFindings(moveStats),
    ...changeFindings(changes, policy),
  ].sort((a, b) => b.weight - a.weight);

  const notes: string[] = [];
  const withEstimate = closed.filter((t) => t.expectedProfit !== null).length;
  if (closed.length && withEstimate === 0) notes.push("No trip in this window has a recorded estimate yet (tracking started 2026-10-15), so estimate accuracy and calibration are empty.");
  if (!input.snapshots.length) notes.push("No market snapshots in the window: recovery times and price-move attribution are empty.");
  if (changes.some((c) => c.tooRecent)) notes.push("Some settings changes are too recent for a full after-window; they are listed without a verdict.");

  return {
    window: { from: new Date(input.fromMs).toISOString(), to: new Date(input.nowMs).toISOString(), hours: round2((input.nowMs - input.fromMs) / 3_600_000) },
    summary: {
      trips: closed.length,
      netProfit: Math.round(closed.reduce((s, t) => s + tripNetAll(t), 0)),
      profitPerHour: whole.profitPerHour,
      overheadShare: whole.overheadShare,
      positioningCosts: Math.round(closed.reduce((s, t) => s + t.positioningCosts, 0)),
      tripsWithEstimate: withEstimate,
      configChanges: changes.length,
      priceMovesAttributed: moves.length,
    },
    findings: findings.slice(0, 40),
    suggestions: rankSuggestions(findings).slice(0, 15),
    routes: { best: routes.slice(0, LIMIT), worst: [...routes].sort((a, b) => a.netProfit - b.netProfit).slice(0, LIMIT).filter((r) => r.netProfit < 0) },
    markets: impact.filter((m) => m.measured > 0 || m.notRecovered > 0).slice(0, 20),
    priceMoves: moveStats.slice(0, 20),
    changes: changes.slice(-20),
    calibration: { fleet: calibration.fleet, routes: calibration.routes.slice(0, 20), goods: calibration.goods.slice(0, 20) },
    notes,
  };
}
