import type { Store, SeasonWeekRow } from "../db/store.js";
import { parseUniverseKey } from "./universe.js";
import { evaluateGoal, isPhase, metricsFromRunResult, type Goal, type WeekRecord } from "./season.js";

/**
 * Close a season week whose universe has already ended, from the scoreboard row the reset saved for it (run_results).
 *
 * The normal close runs a live analysis, which only sees the current universe: after a reset it would score the new week's first
 * hours as the old week's. This reads the saved row for the week's own universe instead, so it is correct at any time after the reset
 * and is also what the reset itself calls. It saves no analysis report (findingsId stays null): the market snapshots a report needs are
 * wiped at the reset.
 */
export async function closeWeekFromResults(store: Store, tenantId: string, agentSymbol: string, week: SeasonWeekRow, now = Date.now()): Promise<SeasonWeekRow> {
  const parsed = week.universeKey ? parseUniverseKey(week.universeKey) : undefined;
  if (!parsed) throw new Error(`the week has no universe to read results for (week ${week.weekNo})`);
  const row = await store.runResultFor(agentSymbol, parsed.resetDate);
  if (!row) throw new Error(`no saved results for ${agentSymbol} in the ${parsed.resetDate} universe`);
  const metrics = metricsFromRunResult(row as never);
  const goals = (week.goals as Goal[]).map((g) => evaluateGoal(g, metrics, true));
  const record: WeekRecord = { phase: isPhase(week.phase) ? week.phase : "recover", goals, metrics, closedAt: new Date(now).toISOString() };
  const closed = await store.closeSeasonWeek(tenantId, week.id, { goals, record, findingsId: null });
  if (!closed) throw new Error(`week ${week.weekNo} was already closed`);
  return closed;
}

/** The reset's call: close the open week if it belongs to the universe that just ended. Returns a one-line outcome for the log. */
export async function closeEndedWeek(store: Store, tenantId: string, agentSymbol: string, endedResetDate: string): Promise<string> {
  const season = await store.activeSeason(tenantId);
  if (!season) return "no active season";
  const open = (await store.seasonWeeks(tenantId, season.id)).find((w) => !w.closedAt);
  if (!open) return "no open season week";
  const parsed = open.universeKey ? parseUniverseKey(open.universeKey) : undefined;
  if (!parsed || parsed.resetDate !== endedResetDate) return `open week ${open.weekNo} belongs to ${open.universeKey ?? "no universe"}, not ${endedResetDate}`;
  await closeWeekFromResults(store, tenantId, agentSymbol, open);
  return `closed season week ${open.weekNo} from the saved results`;
}
