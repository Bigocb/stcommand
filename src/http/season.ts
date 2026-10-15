import { Router, type Request } from "express";
import type { TenantWorker } from "../engine/tenantRegistry.js";
import type { SeasonRow, SeasonWeekRow } from "../db/store.js";
import { tenantUniverse } from "../db/pool.js";
import { runAnalysis, runAnalysisCached } from "../ops/analysis.js";
import { paceRates } from "../ops/pace.js";
import { configChangeEvent } from "../engine/actionEvents.js";
import {
  evaluateGoal, GOAL_METRICS, isPhase, metricsFromReport, normalizeGoal, openingFor, PHASE_INFO, PHASES,
  type Goal, type GoalMetric, type Phase, type WeekRecord,
} from "../engine/season.js";

/**
 * The season plan over HTTP (docs/multi-week-plan.md, src/engine/season.ts), for the Season screen and the Tower card.
 * Mounted inside the dashboard router, behind the same session auth and tenant resolution as every other /api route.
 *
 *   GET  /api/season               the active season, its current week (opened from the last one if needed) with live
 *                                  goal status, every week, and the top suggestions. ?live=0 skips the analysis.
 *   POST /api/season               start a season { name, notes? } (ends the active one)
 *   POST /api/season/end           end the active season
 *   PUT  /api/season/week          change the current week { phase?, goals?, notes? }
 *   POST /api/season/week/close    close the current week: save the analysis report, score the goals, open the next week
 *   POST /api/analysis/capture     save an analysis report { sinceHours?, label? } (mounted by the dashboard router)
 */

const hoursSince = (iso: string, nowMs: number) => Math.min(168, Math.max(1, (nowMs - Date.parse(iso)) / 3_600_000));

/** The open week, opening the next one from the last closed week when none is open. */
async function currentWeek(w: TenantWorker, season: SeasonRow, weeks: SeasonWeekRow[]): Promise<{ week: SeasonWeekRow; weeks: SeasonWeekRow[] }> {
  const open = weeks.find((x) => !x.closedAt);
  if (open) return { week: open, weeks };
  const last = weeks[weeks.length - 1];
  const opening = openingFor(last ? { weekNo: last.weekNo, phase: isPhase(last.phase) ? last.phase : "recover", record: (last.record as WeekRecord | null) ?? null } : undefined);
  const week = await w.store.openSeasonWeek(w.tenantId, { seasonId: season.id, weekNo: (last?.weekNo ?? 0) + 1, phase: opening.phase, goals: opening.goals });
  return { week, weeks: [...weeks, week] };
}

async function payload(w: TenantWorker, live: boolean): Promise<Record<string, unknown>> {
  const meta = {
    phases: PHASES.map((key) => ({ key, ...PHASE_INFO[key] })),
    metrics: Object.entries(GOAL_METRICS).map(([key, m]) => ({ key, ...m })),
    universeKey: tenantUniverse(w.tenantId) ?? null,
  };
  const season = await w.store.activeSeason(w.tenantId);
  if (!season) return { season: null, week: null, weeks: [], live: null, ...meta };
  const { week, weeks } = await currentWeek(w, season, await w.store.seasonWeeks(w.tenantId, season.id));
  let liveOut: Record<string, unknown> | null = null;
  let goals = week.goals as Goal[];
  if (live) {
    const now = Date.now();
    const hours = hoursSince(week.openedAt, now);
    const report = await runAnalysisCached(w, hours, now);
    const metrics = metricsFromReport(report);
    goals = goals.map((g) => evaluateGoal(g, metrics, false));
    liveOut = { hours: Math.round(hours * 10) / 10, metrics, summary: report.summary, suggestions: report.suggestions.slice(0, 5), findings: report.findings.slice(0, 5), notes: report.notes, pace: await paceRates(w, now) };
  }
  const stale = week.universeKey !== null && meta.universeKey !== null && week.universeKey !== meta.universeKey;
  return {
    season,
    week: { ...week, goals, staleUniverse: stale },
    weeks: weeks.map((x) => ({
      id: x.id, weekNo: x.weekNo, phase: x.phase, universeKey: x.universeKey, openedAt: x.openedAt, closedAt: x.closedAt,
      findingsId: x.findingsId, record: x.record, goals: x.goals,
    })),
    live: liveOut,
    ...meta,
  };
}

export function createSeasonRouter(worker: (req: Request) => TenantWorker | undefined): Router {
  const router = Router();
  const withWorker = (fn: (w: TenantWorker, req: Request) => Promise<unknown>) => async (req: Request, res: any) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      res.json(await fn(w, req));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/^(a |the |unknown |no active)/.test(message) ? 400 : 500).json({ error: message });
    }
  };

  router.get("/", withWorker((w, req) => payload(w, req.query.live !== "0")));

  router.post("/", withWorker(async (w, req) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) throw new Error("a season needs a name");
    const season = await w.store.startSeason(w.tenantId, name.slice(0, 120), typeof req.body?.notes === "string" ? req.body.notes.slice(0, 2000) : undefined);
    await w.store.openSeasonWeek(w.tenantId, { seasonId: season.id, weekNo: 1, phase: "recover", goals: [] });
    w.fleet.recordAction(configChangeEvent({ setting: "season", before: null, after: { name: season.name }, atIso: new Date().toISOString(), reason: `season started: ${season.name}` }));
    return payload(w, false);
  }));

  router.post("/end", withWorker(async (w) => {
    const season = await w.store.activeSeason(w.tenantId);
    if (!season) throw new Error("no active season to end");
    await w.store.endSeason(w.tenantId);
    w.fleet.recordAction(configChangeEvent({ setting: "season", before: { name: season.name }, after: null, atIso: new Date().toISOString(), reason: `season ended: ${season.name}` }));
    return payload(w, false);
  }));

  router.put("/week", withWorker(async (w, req) => {
    const season = await w.store.activeSeason(w.tenantId);
    if (!season) throw new Error("no active season: start one first");
    const weeks = await w.store.seasonWeeks(w.tenantId, season.id);
    const { week } = await currentWeek(w, season, weeks);
    const body = req.body ?? {};
    const patch: { phase?: Phase; goals?: Goal[]; notes?: string | null } = {};
    if (body.phase !== undefined) {
      if (!isPhase(body.phase)) throw new Error(`unknown phase: ${String(body.phase)}`);
      patch.phase = body.phase;
    }
    if (body.goals !== undefined) {
      if (!Array.isArray(body.goals) || body.goals.length > 30) throw new Error("goals must be a list of at most 30");
      const existing = new Map((week.goals as Goal[]).map((g) => [g.id, g]));
      const lastRecord = [...weeks].reverse().find((x) => x.closedAt)?.record as WeekRecord | undefined;
      let liveMetrics: Partial<Record<GoalMetric, number | null>> | undefined;
      const goals: Goal[] = [];
      for (const raw of body.goals) {
        const g = normalizeGoal(raw, existing.get((raw as { id?: string })?.id ?? ""));
        // A relative goal ("5% lower") is measured against last week's value, or, in a season's first week, the value
        // when it was set.
        if (g.metric && g.changePct !== undefined && (g.baseline === undefined || g.baseline === null)) {
          const fromLast = lastRecord?.metrics?.[g.metric];
          if (fromLast !== undefined && fromLast !== null) g.baseline = fromLast;
          else {
            liveMetrics ??= metricsFromReport(await runAnalysisCached(w, hoursSince(week.openedAt, Date.now()), Date.now()));
            g.baseline = liveMetrics[g.metric] ?? null;
          }
        }
        goals.push(g);
      }
      patch.goals = goals;
    }
    if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes).slice(0, 4000);
    const before = { phase: week.phase, goals: (week.goals as Goal[]).length };
    await w.store.updateSeasonWeek(w.tenantId, week.id, patch);
    if (patch.phase && patch.phase !== week.phase) {
      w.fleet.recordAction(configChangeEvent({ setting: "season:phase", before: week.phase, after: patch.phase, atIso: new Date().toISOString() }));
    }
    if (patch.goals) {
      w.fleet.recordAction(configChangeEvent({ setting: "season:goals", before, after: { phase: patch.phase ?? week.phase, goals: patch.goals.length }, atIso: new Date().toISOString(), reason: `week ${week.weekNo} goals: ${patch.goals.map((g) => g.text).join("; ").slice(0, 300)}` }));
    }
    return payload(w, false);
  }));

  router.post("/week/close", withWorker(async (w, req) => {
    const season = await w.store.activeSeason(w.tenantId);
    if (!season) throw new Error("no active season: start one first");
    const { week } = await currentWeek(w, season, await w.store.seasonWeeks(w.tenantId, season.id));
    const now = Date.now();
    const report = await runAnalysis(w, hoursSince(week.openedAt, now), now);
    const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 200) : `${season.name}, week ${week.weekNo}`;
    const findingsId = await w.store.saveAnalysisFindings(w.tenantId, { windowStart: report.window.from, windowEnd: report.window.to, label, report });
    const metrics = metricsFromReport(report);
    const goals = (week.goals as Goal[]).map((g) => evaluateGoal(g, metrics, true));
    const record: WeekRecord = { phase: isPhase(week.phase) ? week.phase : "recover", goals, metrics, closedAt: new Date(now).toISOString() };
    await w.store.closeSeasonWeek(w.tenantId, week.id, { goals, record, findingsId });
    w.fleet.recordAction(configChangeEvent({
      setting: "season:week", before: { week: week.weekNo, open: true }, after: { week: week.weekNo, open: false, met: goals.filter((g) => g.status === "met").length, missed: goals.filter((g) => g.status === "missed").length },
      atIso: new Date(now).toISOString(), reason: `week ${week.weekNo} closed (report #${findingsId})`,
    }));
    return payload(w, false);
  }));

  return router;
}

/** POST /api/analysis/capture: save an analysis report now, for the Weeks tab's "Save a report" button. */
export function createAnalysisRouter(worker: (req: Request) => TenantWorker | undefined): Router {
  const router = Router();
  router.post("/capture", async (req, res) => {
    const w = worker(req);
    if (!w) return res.status(503).json({ error: "engine not ready" });
    try {
      const hours = Math.min(168, Math.max(1, Number(req.body?.sinceHours) || 24));
      const now = Date.now();
      const report = await runAnalysis(w, hours, now);
      const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 200) : undefined;
      const id = await w.store.saveAnalysisFindings(w.tenantId, { windowStart: report.window.from, windowEnd: report.window.to, label, report });
      res.json({ ok: true, id, window: report.window, summary: report.summary });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
