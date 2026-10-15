/**
 * Market impact: how far our own trades move a market's price, and how long it takes to come back.
 *
 * Pure. A cluster is one ship's consecutive lots of one good at one market, on one side, less than three minutes
 * apart. Its impact per lot comes from our own fill prices (first lot to last lot), so it needs no snapshots. Recovery
 * comes from the snapshots after the cluster: the first one whose price is back within `recoveredWithin` of the last
 * snapshot before it. Compared with the route model's 4.5% per lot (routeEconomics.ts).
 */
import type { AnalysisLedgerRow, AnalysisSnapshotRow } from "../../db/store.js";
import { confidenceFor, median, pct, round2, type AnalysisPolicy, type Finding } from "./types.js";

const CLUSTER_GAP_MS = 3 * 60_000;

export interface TradeCluster {
  shipSymbol: string;
  waypoint: string;
  good: string;
  side: "buy" | "sell";
  startMs: number;
  endMs: number;
  lots: number;
  units: number;
  firstPrice: number;
  lastPrice: number;
  /** Price move per trade-volume lot, as a positive fraction in the expected direction (up for buys, down for sells). */
  impactPerLot: number | null;
  /** Minutes until the price was back, null when it wasn't seen to recover; `censored` says which. */
  recoveryMinutes: number | null;
  censored: boolean;
}

export function clusterTrades(rows: readonly AnalysisLedgerRow[], snapshots: readonly AnalysisSnapshotRow[], policy: AnalysisPolicy, nowMs: number): TradeCluster[] {
  const trades = rows
    .filter((r) => (r.type === "PURCHASE" || r.type === "SELL") && r.good && r.waypoint && r.pricePerUnit > 0)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const snaps = new Map<string, AnalysisSnapshotRow[]>();
  for (const s of snapshots) (snaps.get(`${s.waypoint}|${s.good}`) ?? snaps.set(`${s.waypoint}|${s.good}`, []).get(`${s.waypoint}|${s.good}`)!).push(s);
  for (const list of snaps.values()) list.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const clusters: TradeCluster[] = [];
  const open = new Map<string, TradeCluster & { _lastMs: number }>();
  const close = (c: TradeCluster & { _lastMs: number }) => {
    const { _lastMs, ...rest } = c;
    clusters.push(rest);
  };
  for (const r of trades) {
    const at = Date.parse(r.timestamp);
    const side = r.type === "PURCHASE" ? "buy" : "sell";
    const key = `${r.shipSymbol}|${r.waypoint}|${r.good}|${side}`;
    const c = open.get(key);
    if (c && at - c._lastMs <= CLUSTER_GAP_MS) {
      c.lots += 1;
      c.units += r.units;
      c.lastPrice = r.pricePerUnit;
      c.endMs = at;
      c._lastMs = at;
      continue;
    }
    if (c) close(c);
    open.set(key, {
      shipSymbol: r.shipSymbol, waypoint: r.waypoint!, good: r.good!, side, startMs: at, endMs: at, lots: 1, units: r.units,
      firstPrice: r.pricePerUnit, lastPrice: r.pricePerUnit, impactPerLot: null, recoveryMinutes: null, censored: false, _lastMs: at,
    });
  }
  for (const c of open.values()) close(c);

  for (const c of clusters) {
    const series = snaps.get(`${c.waypoint}|${c.good}`) ?? [];
    const priceOf = (s: AnalysisSnapshotRow) => (c.side === "buy" ? s.purchasePrice : s.sellPrice);
    if (c.lots >= 2 && c.firstPrice > 0) {
      // Lots after the first, in trade-volume units: the first lot traded at the starting price.
      const before = [...series].reverse().find((s) => Date.parse(s.timestamp) <= c.startMs);
      const volume = before?.tradeVolume && before.tradeVolume > 0 ? before.tradeVolume : c.units / c.lots;
      const lotsMoved = Math.max(1, (c.units - c.units / c.lots) / volume);
      const move = (c.lastPrice - c.firstPrice) / c.firstPrice;
      c.impactPerLot = round2((c.side === "buy" ? move : -move) / lotsMoved * 100) / 100;
    }
    const baseline = [...series].reverse().find((s) => Date.parse(s.timestamp) <= c.startMs);
    if (baseline) {
      const base = priceOf(baseline);
      const after = series.filter((s) => Date.parse(s.timestamp) > c.endMs);
      const back = after.find((s) => base > 0 && Math.abs(priceOf(s) - base) / base <= policy.recoveredWithin);
      if (back) c.recoveryMinutes = Math.round((Date.parse(back.timestamp) - c.endMs) / 60_000);
      else {
        c.censored = true;
        // Not back yet: how long it has stayed away, as a lower bound.
        c.recoveryMinutes = after.length ? Math.round((nowMs - c.endMs) / 60_000) : null;
      }
    }
  }
  return clusters;
}

/** A fraction to four places (a tenth of a percent), so a median of two values doesn't print float noise. */
const roundShare = (x: number | null): number | null => (x === null ? null : Math.round(x * 10_000) / 10_000);

export interface MarketImpactStat {
  key: string;
  waypoint: string;
  good: string;
  side: "buy" | "sell";
  clusters: number;
  measured: number;
  medianImpactPerLot: number | null;
  recoverySeen: number;
  medianRecoveryMinutes: number | null;
  notRecovered: number;
  units: number;
  ships: string[];
}

export function summarizeImpact(clusters: readonly TradeCluster[]): MarketImpactStat[] {
  const by = new Map<string, TradeCluster[]>();
  for (const c of clusters) {
    const key = `${c.good}@${c.waypoint} ${c.side}`;
    (by.get(key) ?? by.set(key, []).get(key)!).push(c);
  }
  const out: MarketImpactStat[] = [];
  for (const [key, list] of by) {
    const impacts = list.map((c) => c.impactPerLot).filter((x): x is number => x !== null);
    const recovered = list.filter((c) => !c.censored && c.recoveryMinutes !== null).map((c) => c.recoveryMinutes!);
    out.push({
      key, waypoint: list[0]!.waypoint, good: list[0]!.good, side: list[0]!.side,
      clusters: list.length, measured: impacts.length, medianImpactPerLot: roundShare(median(impacts)),
      recoverySeen: recovered.length, medianRecoveryMinutes: median(recovered),
      notRecovered: list.filter((c) => c.censored).length,
      units: list.reduce((s, c) => s + c.units, 0),
      ships: [...new Set(list.map((c) => c.shipSymbol))].sort(),
    });
  }
  return out.sort((a, b) => (b.medianImpactPerLot ?? 0) - (a.medianImpactPerLot ?? 0));
}

export function impactFindings(stats: readonly MarketImpactStat[], policy: AnalysisPolicy, tradeVolumeOf: (waypoint: string, good: string) => number | undefined): Finding[] {
  const out: Finding[] = [];
  const heavy = policy.modelImpactPerLot * policy.heavyImpactFactor;
  for (const s of stats) {
    if (s.measured >= 2 && s.medianImpactPerLot !== null && s.medianImpactPerLot > heavy) {
      const volume = tradeVolumeOf(s.waypoint, s.good);
      const lotSize = volume ? Math.max(1, Math.round(volume / 2)) : undefined;
      out.push({
        id: `impact:${s.key}`, kind: "market_impact", subject: s.key, sampleSize: s.measured, confidence: confidenceFor(s.measured),
        weight: Math.round(s.units * (s.medianImpactPerLot - policy.modelImpactPerLot) * 10),
        headline: `Our ${s.side}s move ${s.good} at ${s.waypoint} ${pct(s.medianImpactPerLot)} a lot, against the model's ${pct(policy.modelImpactPerLot)} (${s.measured} trades)`,
        evidence: { medianImpactPerLot: s.medianImpactPerLot, modelImpactPerLot: policy.modelImpactPerLot, trades: s.measured, units: s.units, ships: s.ships.join(" ") },
        suggestion: {
          action: `Cap the lot size for ${s.ships.slice(0, 3).join(", ")} trading here${lotSize ? ` (about ${lotSize} units, half the market's trade volume)` : ""}`,
          why: "smaller lots spread the price move; the route model assumes a lighter market",
          tool: "stcommand_set_ship_lot_policy",
          args: { shipSymbol: s.ships[0], ...(lotSize ? { lotSize } : {}) },
        },
      });
    }
    const slow = s.medianRecoveryMinutes !== null && s.medianRecoveryMinutes > policy.slowRecoveryMinutes;
    const stuck = s.notRecovered >= 2 && s.notRecovered >= s.recoverySeen;
    if (slow || stuck) {
      out.push({
        id: `recovery:${s.key}`, kind: "market_recovery", subject: s.key, sampleSize: s.clusters, confidence: confidenceFor(s.clusters),
        weight: Math.round(s.units),
        headline: slow
          ? `${s.good} at ${s.waypoint} takes about ${s.medianRecoveryMinutes} min to recover after our ${s.side}s`
          : `${s.good} at ${s.waypoint} hadn't recovered after ${s.notRecovered} of our ${s.clusters} ${s.side} runs`,
        evidence: { medianRecoveryMinutes: s.medianRecoveryMinutes, recovered: s.recoverySeen, notRecovered: s.notRecovered, runs: s.clusters },
        suggestion: {
          action: `Space trips to ${s.good} at ${s.waypoint}, or split them across ships and markets`,
          why: "a run that starts before the price is back pays the last run's impact again",
        },
      });
    }
  }
  return out;
}

/** The latest trade volume seen per market and good, for sizing a suggested lot cap. */
export function latestTradeVolumes(snapshots: readonly AnalysisSnapshotRow[]): (waypoint: string, good: string) => number | undefined {
  const latest = new Map<string, { at: number; volume: number }>();
  for (const s of snapshots) {
    const key = `${s.waypoint}|${s.good}`;
    const at = Date.parse(s.timestamp);
    const cur = latest.get(key);
    if (!cur || at > cur.at) latest.set(key, { at, volume: s.tradeVolume });
  }
  return (waypoint, good) => latest.get(`${waypoint}|${good}`)?.volume;
}
