/**
 * Two profit-per-hour rates, each over its own window, so the Metrics page and the season show the same numbers:
 *
 *   sinceSeason  the open season week, from when it opened (the figure season goals are scored on)
 *   sinceReset   the current universe, from its start (the start is the next scheduled reset less a week)
 *
 * Both come from the analysis report (src/engine/analysis/report.ts), so they count trips that closed in the window and
 * subtract each trip's own refuel, jump and positioning costs. Metrics' own "Per hour" counts sales instead, so it can
 * differ; the Metrics page labels each figure with its window and definition.
 */
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { resetWatcherStatus } from "../engine/resetWatcher.js";
import { runAnalysisCached } from "./analysis.js";

export interface PaceRate {
  hours: number;
  profitPerHour: number;
  trips: number;
}

export interface Pace {
  sinceSeason: (PaceRate & { weekNo: number }) | null;
  sinceReset: PaceRate | null;
}

const WEEK_HOURS = 168;

export async function paceRates(w: TenantWorker, nowMs: number): Promise<Pace> {
  const season = await w.store.activeSeason(w.tenantId);
  const openWeek = season ? (await w.store.seasonWeeks(w.tenantId, season.id)).find((x) => !x.closedAt) : undefined;
  const sinceSeason = openWeek
    ? await rateOver(w, Date.parse(openWeek.openedAt), nowMs).then((r) => (r ? { ...r, weekNo: openWeek.weekNo } : null))
    : null;

  const nextReset = Date.parse(resetWatcherStatus()?.nextReset ?? "");
  const sinceReset = Number.isFinite(nextReset) ? await rateOver(w, nextReset - WEEK_HOURS * 3_600_000, nowMs) : null;
  return { sinceSeason, sinceReset };
}

/** The rate from `startMs` to now. Null before an hour has passed (a rate over a few minutes is noise). */
async function rateOver(w: TenantWorker, startMs: number, nowMs: number): Promise<PaceRate | null> {
  const hours = Math.min(WEEK_HOURS, (nowMs - startMs) / 3_600_000);
  if (!(hours >= 1)) return null;
  const report = await runAnalysisCached(w, hours, nowMs);
  return { hours: Math.round(hours * 10) / 10, profitPerHour: report.summary.profitPerHour, trips: report.summary.trips };
}
