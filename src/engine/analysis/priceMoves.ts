/**
 * Price moves: who moved a market. For each move of at least `priceMoveThreshold` between consecutive snapshots of a
 * market and good, looks at the trades in that window: ours (ledger), another agent's (market_transactions from a ship
 * that isn't ours), both, or none seen ("unexplained": drift, the market's own tick, or trades we didn't observe).
 *
 * Pure.
 */
import type { AnalysisLedgerRow, AnalysisSnapshotRow } from "../../db/store.js";
import { confidenceFor, pct, round2, type AnalysisPolicy, type Finding } from "./types.js";

export interface MarketTrade { timestamp: string; waypoint: string; good: string; shipSymbol: string; type: string; units: number }

export type MoveCause = "ours" | "others" | "both" | "unexplained";

export interface PriceMove {
  waypoint: string;
  good: string;
  fromMs: number;
  toMs: number;
  /** The larger relative move of the buy or sell price, signed. */
  change: number;
  cause: MoveCause;
  otherShips: string[];
}

export function attributePriceMoves(
  snapshots: readonly AnalysisSnapshotRow[],
  ourTrades: readonly AnalysisLedgerRow[],
  marketTrades: readonly MarketTrade[],
  ourShips: ReadonlySet<string>,
  policy: AnalysisPolicy,
): PriceMove[] {
  const series = new Map<string, AnalysisSnapshotRow[]>();
  for (const s of snapshots) (series.get(`${s.waypoint}|${s.good}`) ?? series.set(`${s.waypoint}|${s.good}`, []).get(`${s.waypoint}|${s.good}`)!).push(s);
  const ours = new Map<string, number[]>();
  for (const r of ourTrades) {
    if ((r.type !== "PURCHASE" && r.type !== "SELL") || !r.good || !r.waypoint) continue;
    (ours.get(`${r.waypoint}|${r.good}`) ?? ours.set(`${r.waypoint}|${r.good}`, []).get(`${r.waypoint}|${r.good}`)!).push(Date.parse(r.timestamp));
  }
  const others = new Map<string, { at: number; ship: string }[]>();
  for (const t of marketTrades) {
    if (ourShips.has(t.shipSymbol)) continue;
    (others.get(`${t.waypoint}|${t.good}`) ?? others.set(`${t.waypoint}|${t.good}`, []).get(`${t.waypoint}|${t.good}`)!).push({ at: Date.parse(t.timestamp), ship: t.shipSymbol });
  }

  const moves: PriceMove[] = [];
  for (const [key, list] of series) {
    list.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      const buy = a.purchasePrice > 0 ? (b.purchasePrice - a.purchasePrice) / a.purchasePrice : 0;
      const sell = a.sellPrice > 0 ? (b.sellPrice - a.sellPrice) / a.sellPrice : 0;
      const change = Math.abs(buy) >= Math.abs(sell) ? buy : sell;
      if (Math.abs(change) < policy.priceMoveThreshold) continue;
      const fromMs = Date.parse(a.timestamp);
      const toMs = Date.parse(b.timestamp);
      const inWindow = (at: number) => at > fromMs && at <= toMs;
      const usTraded = (ours.get(key) ?? []).some(inWindow);
      const otherShips = [...new Set((others.get(key) ?? []).filter((o) => inWindow(o.at)).map((o) => o.ship))].sort();
      const cause: MoveCause = usTraded && otherShips.length ? "both" : usTraded ? "ours" : otherShips.length ? "others" : "unexplained";
      moves.push({ waypoint: a.waypoint, good: a.good, fromMs, toMs, change: round2(change * 100) / 100, cause, otherShips });
    }
  }
  return moves;
}

export interface MoveStats {
  key: string;
  moves: number;
  ours: number;
  others: number;
  both: number;
  unexplained: number;
  otherShips: string[];
}

export function summarizeMoves(moves: readonly PriceMove[]): MoveStats[] {
  const by = new Map<string, MoveStats>();
  for (const m of moves) {
    const key = `${m.good}@${m.waypoint}`;
    const s = by.get(key) ?? { key, moves: 0, ours: 0, others: 0, both: 0, unexplained: 0, otherShips: [] };
    s.moves += 1;
    s[m.cause] += 1;
    for (const ship of m.otherShips) if (!s.otherShips.includes(ship)) s.otherShips.push(ship);
    by.set(key, s);
  }
  return [...by.values()].sort((a, b) => b.moves - a.moves);
}

export function moveFindings(stats: readonly MoveStats[]): Finding[] {
  const out: Finding[] = [];
  for (const s of stats) {
    const oursShare = (s.ours + s.both) / s.moves;
    if (s.moves >= 3 && oursShare >= 0.6) {
      out.push({
        id: `moves:ours:${s.key}`, kind: "price_moves", subject: s.key, sampleSize: s.moves, confidence: confidenceFor(s.moves), weight: s.moves * 100,
        headline: `We caused ${pct(oursShare)} of the big price moves on ${s.key} (${s.ours + s.both} of ${s.moves})`,
        evidence: { moves: s.moves, ours: s.ours, both: s.both, others: s.others, unexplained: s.unexplained },
        suggestion: { action: `Treat ${s.key} as a thin market: smaller lots and spaced trips`, why: "our own trades are what move its price" },
      });
    }
    const othersShare = (s.others + s.both) / s.moves;
    if ((s.others + s.both) >= 2 && (othersShare >= 0.4 || s.otherShips.length >= 2)) {
      out.push({
        id: `moves:others:${s.key}`, kind: "competition", subject: s.key, sampleSize: s.moves, confidence: confidenceFor(s.moves), weight: (s.others + s.both) * 100,
        headline: `Other agents traded around ${pct(othersShare)} of the big moves on ${s.key} (${s.otherShips.length} ships seen)`,
        evidence: { moves: s.moves, others: s.others, both: s.both, otherShips: s.otherShips.slice(0, 6).join(" ") },
        suggestion: { action: `Expect competition on ${s.key}: its prices can move between our planning and our arrival`, why: "other agents trade here too" },
      });
    }
  }
  return out;
}
