/**
 * Changes: what a settings change was followed by. For each config_change event, compares trip profit per hour, trip
 * count and overhead share in a window before the change and a window after it (skipping a settle period).
 *
 * Pure. A before/after comparison overlaps everything else that changed in the same hours, so every finding says it is
 * a correlation, with the trips behind each side.
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
    if (r.type === "REFUEL" || r.type === "JUMP") overhead += Math.abs(r.total);
    else if (r.type === "SELL") sales += r.total;
  }
  const hours = Math.max(1e-6, (toMs - fromMs) / 3_600_000);
  return {
    fromMs, toMs, trips: closed.length, profit: Math.round(profit), profitPerHour: Math.round(profit / hours),
    overheadShare: sales > 0 ? round2(overhead / sales) : null,
  };
}

export interface ChangeImpact {
  at: string;
  setting: string;
  before: unknown;
  after: unknown;
  windowBefore: WindowMetrics;
  windowAfter: WindowMetrics | null;
  /** True when the after window hasn't fully happened yet. */
  tooRecent: boolean;
  profitPerHourChange: number | null;
}

export function changeImpacts(events: readonly ActionEventRow[], trips: readonly Trip[], ledger: readonly AnalysisLedgerRow[], policy: AnalysisPolicy, nowMs: number): ChangeImpact[] {
  const w = policy.changeWindowHours * 3_600_000;
  const settle = policy.changeSettleMinutes * 60_000;
  return events
    .filter((e) => e.kind === "config_change" && e.subject)
    .map((e) => {
      const at = Date.parse(e.at);
      const before = windowMetrics(trips, ledger, at - w, at);
      const tooRecent = at + settle + w > nowMs;
      const after = tooRecent ? null : windowMetrics(trips, ledger, at + settle, at + settle + w);
      const ctx = (e.context ?? {}) as { before?: unknown; after?: unknown };
      return {
        at: e.at, setting: e.subject!, before: ctx.before ?? null, after: ctx.after ?? null,
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
    out.push({
      id: `change:${c.setting}:${c.at}`, kind: "change_impact", subject: c.setting, sampleSize: n, confidence: confidenceFor(n),
      weight: Math.abs(c.windowAfter.profitPerHour - c.windowBefore.profitPerHour) * policy.changeWindowHours,
      headline: `After ${c.setting} changed (${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}), profit per hour went ${up ? "up" : "down"} ${pct(Math.abs(c.profitPerHourChange))} (${c.windowBefore.trips} trips before, ${c.windowAfter.trips} after; correlation, not proof)`,
      evidence: {
        profitPerHourBefore: c.windowBefore.profitPerHour, profitPerHourAfter: c.windowAfter.profitPerHour,
        overheadBefore: c.windowBefore.overheadShare, overheadAfter: c.windowAfter.overheadShare,
        tripsBefore: c.windowBefore.trips, tripsAfter: c.windowAfter.trips,
      },
      suggestion: !up && doctrineKey && before
        ? {
          action: `Consider putting ${doctrineKey} back to ${JSON.stringify(before)} and comparing again`,
          why: "profit per hour fell after the change; other things changed too, so check before reverting",
          tool: "stcommand_set_doctrine",
          args: { key: doctrineKey, ...(before.value !== undefined ? { value: before.value } : {}), ...(before.enabled !== undefined ? { enabled: before.enabled } : {}) },
        }
        : undefined,
    });
  }
  return out;
}
