/**
 * Changes: what a settings change was followed by. For each config_change event, compares trip profit per hour, trip
 * count and overhead share in a window before the change and a window after it (skipping a settle period).
 *
 * Pure. A before/after comparison overlaps everything else that changed in the same hours, so every finding says it is
 * a correlation, with the trips behind each side. A change to one ship (its lot policy) is measured on that ship's own
 * trips and costs: the fleet's numbers would mostly measure what every other ship did in those hours.
 */
import type { ActionEventRow, AnalysisLedgerRow } from "../../db/store.js";
import { tripNetAll, type Trip } from "./trips.js";
import { confidenceFor, pct, round2, type AnalysisPolicy, type Finding } from "./types.js";

export interface WindowMetrics {
  fromMs: number;
  toMs: number;
  trips: number;
  profit: number;
  profitPerHour: number;
  /** Refuel and jump spend over gross sales. */
  overheadShare: number | null;
}

export function windowMetrics(trips: readonly Trip[], ledger: readonly AnalysisLedgerRow[], fromMs: number, toMs: number): WindowMetrics {
  const closed = trips.filter((t) => t.endMs !== null && t.endMs > fromMs && t.endMs <= toMs);
  const profit = closed.reduce((s, t) => s + tripNetAll(t), 0);
  let overhead = 0;
  let sales = 0;
  for (const r of ledger) {
    const at = Date.parse(r.timestamp);
    if (at <= fromMs || at > toMs) continue;
    if (r.type === "REFUEL" || r.type === "JUMP" || (r.type === "SHIP" && (r.good === "REPAIR" || r.total < 0))) overhead += Math.abs(r.total);
    else if (r.type === "SELL") sales += r.total;
  }
  const hours = Math.max(1e-6, (toMs - fromMs) / 3_600_000);
  return {
    fromMs, toMs, trips: closed.length, profit: Math.round(profit), profitPerHour: Math.round(profit / hours),
    // Four places: overhead is usually a few percent, and two places would round it to whole percents.
    overheadShare: sales > 0 ? Math.round((overhead / sales) * 10_000) / 10_000 : null,
  };
}

/**
 * The same figures as windowMetrics() for any number of windows over one (trips, ledger) pair: sorted once, with running
 * totals, so each window is two binary searches (2026-11-28: changeImpacts ran windowMetrics twice per settings change,
 * each a full pass over the week's ledger with a Date.parse per row; at hour 134 that was 42% of the box's CPU while a
 * Season screen was open). A row whose time does not parse falls inside every window, as it does in windowMetrics().
 */
export interface WindowIndex { metrics(fromMs: number, toMs: number): WindowMetrics }

function upperBound(keys: Float64Array, v: number): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (keys[mid]! <= v) lo = mid + 1; else hi = mid; }
  return lo;
}

export function windowIndex(trips: readonly Trip[], ledger: readonly AnalysisLedgerRow[]): WindowIndex {
  const tripRows = trips.filter((t) => t.endMs !== null).map((t) => ({ at: t.endMs as number, net: tripNetAll(t) })).sort((a, b) => a.at - b.at);
  const tripAt = Float64Array.from(tripRows, (r) => r.at);
  const tripNet = new Float64Array(tripRows.length + 1);
  for (let i = 0; i < tripRows.length; i++) tripNet[i + 1] = tripNet[i]! + tripRows[i]!.net;

  let undatedOverhead = 0, undatedSales = 0;
  const rows: { at: number; overhead: number; sales: number }[] = [];
  for (const r of ledger) {
    const isOverhead = r.type === "REFUEL" || r.type === "JUMP" || (r.type === "SHIP" && (r.good === "REPAIR" || r.total < 0));
    const overhead = isOverhead ? Math.abs(r.total) : 0;
    const sales = !isOverhead && r.type === "SELL" ? r.total : 0;
    if (overhead === 0 && sales === 0) continue;
    const at = Date.parse(r.timestamp);
    if (Number.isNaN(at)) { undatedOverhead += overhead; undatedSales += sales; continue; }
    rows.push({ at, overhead, sales });
  }
  rows.sort((a, b) => a.at - b.at);
  const ledgerAt = Float64Array.from(rows, (r) => r.at);
  const overheadSum = new Float64Array(rows.length + 1);
  const salesSum = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) {
    overheadSum[i + 1] = overheadSum[i]! + rows[i]!.overhead;
    salesSum[i + 1] = salesSum[i]! + rows[i]!.sales;
  }

  return {
    metrics(fromMs, toMs) {
      // A window edge that is not a number compares false everywhere; the plain scan says exactly what that means.
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return windowMetrics(trips, ledger, fromMs, toMs);
      // (fromMs, toMs]: everything at or before toMs, less everything at or before fromMs. An empty or reversed window is empty.
      const span = (keys: Float64Array): [number, number] => {
        const a = upperBound(keys, fromMs), b = upperBound(keys, toMs);
        return b > a ? [a, b] : [a, a];
      };
      const [ta, tb] = span(tripAt);
      const [la, lb] = span(ledgerAt);
      const profit = tripNet[tb]! - tripNet[ta]!;
      const overhead = overheadSum[lb]! - overheadSum[la]! + undatedOverhead;
      const sales = salesSum[lb]! - salesSum[la]! + undatedSales;
      const hours = Math.max(1e-6, (toMs - fromMs) / 3_600_000);
      return {
        fromMs, toMs, trips: tb - ta, profit: Math.round(profit), profitPerHour: Math.round(profit / hours),
        overheadShare: sales > 0 ? Math.round((overhead / sales) * 10_000) / 10_000 : null,
      };
    },
  };
}

export interface ChangeImpact {
  at: string;
  setting: string;
  /** The ship the change applies to, when it applies to one; the windows then count only its trips. */
  ship: string | null;
  before: unknown;
  after: unknown;
  windowBefore: WindowMetrics;
  windowAfter: WindowMetrics | null;
  /** True when the after window hasn't fully happened yet. */
  tooRecent: boolean;
  profitPerHourChange: number | null;
}

/** The ship a change applies to: the event's ship, or the ship named in a `lot_policy:<ship>` setting. */
export function changeScope(e: Pick<ActionEventRow, "shipSymbol" | "subject">): string | null {
  if (e.shipSymbol) return e.shipSymbol;
  const m = /^lot_policy:(.+)$/.exec(e.subject ?? "");
  return m ? m[1]! : null;
}

export function changeImpacts(events: readonly ActionEventRow[], trips: readonly Trip[], ledger: readonly AnalysisLedgerRow[], policy: AnalysisPolicy, nowMs: number): ChangeImpact[] {
  const w = policy.changeWindowHours * 3_600_000;
  const settle = policy.changeSettleMinutes * 60_000;
  // One index for the fleet and one per ship named by a change, built on first use (see windowIndex()).
  const indexes = new Map<string | null, WindowIndex>();
  const indexFor = (ship: string | null): WindowIndex => {
    let idx = indexes.get(ship);
    if (!idx) {
      idx = ship ? windowIndex(trips.filter((x) => x.shipSymbol === ship), ledger.filter((x) => x.shipSymbol === ship)) : windowIndex(trips, ledger);
      indexes.set(ship, idx);
    }
    return idx;
  };
  return events
    .filter((e) => e.kind === "config_change" && e.subject)
    .map((e) => {
      const at = Date.parse(e.at);
      const ship = changeScope(e);
      const idx = indexFor(ship);
      const before = idx.metrics(at - w, at);
      const tooRecent = at + settle + w > nowMs;
      const after = tooRecent ? null : idx.metrics(at + settle, at + settle + w);
      const ctx = (e.context ?? {}) as { before?: unknown; after?: unknown };
      return {
        at: e.at, setting: e.subject!, ship, before: ctx.before ?? null, after: ctx.after ?? null,
        windowBefore: before, windowAfter: after, tooRecent,
        profitPerHourChange: after && before.profitPerHour !== 0 ? round2((after.profitPerHour - before.profitPerHour) / Math.abs(before.profitPerHour)) : null,
      };
    });
}

export function changeFindings(impacts: readonly ChangeImpact[], policy: AnalysisPolicy): Finding[] {
  const out: Finding[] = [];
  for (const c of impacts) {
    if (!c.windowAfter || c.profitPerHourChange === null) continue;
    const n = Math.min(c.windowBefore.trips, c.windowAfter.trips);
    if (n < policy.minTrips) continue;
    const up = c.profitPerHourChange >= 0;
    const doctrineKey = c.setting.startsWith("doctrine:") ? c.setting.slice("doctrine:".length) : undefined;
    const before = c.before as { value?: number; enabled?: boolean } | null;
    const whose = c.ship ? `${c.ship}'s profit per hour` : "fleet profit per hour";
    out.push({
      id: `change:${c.setting}:${c.at}`, kind: "change_impact", subject: c.setting, sampleSize: n, confidence: confidenceFor(n),
      weight: Math.abs(c.windowAfter.profitPerHour - c.windowBefore.profitPerHour) * policy.changeWindowHours,
      headline: `After ${c.setting} changed (${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}), ${whose} went ${up ? "up" : "down"} ${pct(Math.abs(c.profitPerHourChange))} (${c.windowBefore.trips} trips before, ${c.windowAfter.trips} after; correlation, not proof)`,
      evidence: {
        profitPerHourBefore: c.windowBefore.profitPerHour, profitPerHourAfter: c.windowAfter.profitPerHour,
        overheadBefore: c.windowBefore.overheadShare, overheadAfter: c.windowAfter.overheadShare,
        tripsBefore: c.windowBefore.trips, tripsAfter: c.windowAfter.trips,
        scope: c.ship ?? "fleet",
      },
      suggestion: up ? undefined : doctrineKey && before
        ? {
          action: `Consider putting ${doctrineKey} back to ${JSON.stringify(before)} and comparing again`,
          why: "profit per hour fell after the change; other things changed too, so check before reverting",
          tool: "stcommand_set_doctrine",
          args: { key: doctrineKey, ...(before.value !== undefined ? { value: before.value } : {}), ...(before.enabled !== undefined ? { enabled: before.enabled } : {}) },
        }
        : c.ship && c.setting.startsWith("lot_policy:")
          ? {
            action: before ? `Consider putting ${c.ship}'s lot policy back to ${JSON.stringify(before)}` : `Consider clearing ${c.ship}'s lot policy`,
            why: "its profit per hour fell after the change; check its routes changed for other reasons before reverting",
            tool: "stcommand_set_ship_lot_policy",
            args: before ? { shipSymbol: c.ship, ...(before as object) } : { shipSymbol: c.ship, clear: true },
          }
          : undefined,
    });
  }
  return out;
}
