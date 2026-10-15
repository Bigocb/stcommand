/**
 * The season plan: phases, goals, and how one week hands over to the next (docs/multi-week-plan.md).
 *
 * Pure. The store keeps seasons and weeks; the dashboard routes call these to start a week, check its goals against
 * the analysis report, and close it. A week that ends in Cross-system starts the next at Recover, because a reset wipes
 * the gate network those routes depend on; every other phase carries over. A missed goal, or a hand-tracked one still
 * open, carries forward to the next week; a met or dropped one doesn't.
 */

export const PHASES = ["recover", "fund", "specialize", "cross_system", "build"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_INFO: Record<Phase, { label: string; summary: string }> = {
  recover: { label: "Recover", summary: "Re-register, clean up, finish the galaxy crawl, start feeds on the gate's inputs." },
  fund: { label: "Fund", summary: "Trade for cash and buy the right hull for each job." },
  specialize: { label: "Specialize", summary: "Haulers on proven routes, keepers on the markets that matter." },
  cross_system: { label: "Cross-system", summary: "Routes across gates, circuits and warp tours." },
  build: { label: "Build", summary: "The gate and the materials for it." },
};

export function isPhase(x: unknown): x is Phase {
  return typeof x === "string" && (PHASES as readonly string[]).includes(x);
}

/** What a goal can be measured on: numbers the analysis report already has. */
export const GOAL_METRICS = {
  profitPerHour: { label: "Profit per hour", unit: "c/h", better: "higher" },
  netProfit: { label: "Net trip profit", unit: "c", better: "higher" },
  overheadShare: { label: "Overhead (fuel and jumps / sales)", unit: "share", better: "lower" },
  positioningCosts: { label: "Positioning costs", unit: "c", better: "lower" },
  trips: { label: "Completed trips", unit: "trips", better: "higher" },
  estimateAccuracy: { label: "Estimate accuracy (realized / expected)", unit: "ratio", better: "higher" },
  growth: { label: "Growth (cash + holds + hulls, per week)", unit: "%/week", better: "higher" },
} as const;
export type GoalMetric = keyof typeof GOAL_METRICS;

export function isGoalMetric(x: unknown): x is GoalMetric {
  return typeof x === "string" && x in GOAL_METRICS;
}

export type GoalStatus = "pending" | "met" | "missed" | "dropped";

export interface Goal {
  id: string;
  text: string;
  /** Optional: a measurable goal. A goal without a metric is tracked by hand (the operator sets its status). */
  metric?: GoalMetric;
  /** "at least" or "at most". */
  comparator?: ">=" | "<=";
  /** Absolute target, or a change against the baseline in percent (-5 = 5% lower than the baseline). */
  target?: number;
  changePct?: number;
  /** The value a relative goal is measured against: last week's measured value when the week opened. */
  baseline?: number | null;
  status: GoalStatus;
  measured?: number | null;
  /** The week the goal was first set in, when it carried forward. */
  fromWeek?: number;
}

/** The numbers goals are measured on, from an analysis report (src/engine/analysis/report.ts). */
export function metricsFromReport(report: {
  summary: { profitPerHour: number; netProfit: number; overheadShare: number | null; positioningCosts: number; trips: number; growthPerWeek: number | null };
  calibration: { fleet: { factor: number | null } };
}): Record<GoalMetric, number | null> {
  return {
    profitPerHour: report.summary.profitPerHour,
    netProfit: report.summary.netProfit,
    overheadShare: report.summary.overheadShare,
    positioningCosts: report.summary.positioningCosts,
    trips: report.summary.trips,
    estimateAccuracy: report.calibration.fleet.factor,
    growth: report.summary.growthPerWeek,
  };
}

/** The number a goal has to reach, or null when it can't be worked out (a relative goal with no baseline). */
export function goalTarget(g: Goal): number | null {
  if (g.target !== undefined) return g.target;
  if (g.changePct !== undefined && g.baseline !== undefined && g.baseline !== null) return g.baseline * (1 + g.changePct / 100);
  return null;
}

/**
 * Check a goal against this week's numbers. Met as soon as the measure clears the target. While the week is open an
 * unmet goal is pending; at close (`final`) it is missed. A dropped goal, and a hand-tracked goal with no metric, keep
 * the status they have.
 */
export function evaluateGoal(g: Goal, metrics: Partial<Record<GoalMetric, number | null>>, final: boolean): Goal {
  if (g.status === "dropped" || !g.metric) return g;
  const measured = metrics[g.metric] ?? null;
  const target = goalTarget(g);
  if (measured === null || target === null) return { ...g, measured, status: final ? (g.status === "met" ? "met" : "missed") : g.status === "met" ? "met" : "pending" };
  const comparator = g.comparator ?? (GOAL_METRICS[g.metric].better === "lower" ? "<=" : ">=");
  const met = comparator === ">=" ? measured >= target : measured <= target;
  return { ...g, measured, status: met ? "met" : final ? "missed" : "pending" };
}

/** The phase the next week starts in: Recover after Cross-system (the reset wiped those routes), else the same. */
export function startPhaseAfter(previous: Phase): Phase {
  return previous === "cross_system" ? "recover" : previous;
}

/**
 * Goals that carry into the next week: the missed ones, and hand-tracked ones still open (nobody marked them met),
 * pending again, remembering the week they came from.
 */
export function carryForward(goals: readonly Goal[], fromWeekNo: number, lastMetrics: Partial<Record<GoalMetric, number | null>> = {}): Goal[] {
  return goals
    .filter((g) => g.status === "missed" || (g.status === "pending" && !g.metric))
    .map((g) => ({
      ...g,
      status: "pending" as const,
      measured: null,
      fromWeek: g.fromWeek ?? fromWeekNo,
      // A relative goal is measured against where last week ended.
      baseline: g.metric && g.changePct !== undefined ? lastMetrics[g.metric] ?? g.baseline ?? null : g.baseline,
    }));
}

export interface WeekRecord {
  phase: Phase;
  goals: Goal[];
  metrics: Partial<Record<GoalMetric, number | null>>;
  closedAt: string;
}

/** The phase and goals a new week opens with, from the last closed week (or a fresh start). */
export function openingFor(previous: { weekNo: number; record: WeekRecord | null; phase: Phase } | undefined): { phase: Phase; goals: Goal[] } {
  if (!previous) return { phase: "recover", goals: [] };
  const phase = previous.record?.phase ?? previous.phase;
  return {
    phase: startPhaseAfter(phase),
    goals: previous.record ? carryForward(previous.record.goals, previous.weekNo, previous.record.metrics) : [],
  };
}

/** Validate and normalise a goal from the UI. Throws with a one-line reason. */
export function normalizeGoal(input: unknown, existing?: Goal): Goal {
  const g = (input ?? {}) as Record<string, unknown>;
  const text = typeof g.text === "string" ? g.text.trim() : "";
  if (!text) throw new Error("a goal needs a description");
  if (text.length > 300) throw new Error("a goal's description is limited to 300 characters");
  const out: Goal = {
    id: typeof g.id === "string" && g.id ? g.id : existing?.id ?? `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    text,
    status: (["pending", "met", "missed", "dropped"] as const).includes(g.status as GoalStatus) ? (g.status as GoalStatus) : existing?.status ?? "pending",
  };
  if (g.metric !== undefined && g.metric !== null && g.metric !== "") {
    if (!isGoalMetric(g.metric)) throw new Error(`unknown goal metric: ${String(g.metric)}`);
    out.metric = g.metric;
    out.comparator = g.comparator === "<=" ? "<=" : g.comparator === ">=" ? ">=" : undefined;
    const target = g.target === undefined || g.target === null || g.target === "" ? undefined : Number(g.target);
    const change = g.changePct === undefined || g.changePct === null || g.changePct === "" ? undefined : Number(g.changePct);
    if (target !== undefined && !Number.isFinite(target)) throw new Error("the target must be a number");
    if (change !== undefined && !Number.isFinite(change)) throw new Error("the change must be a number");
    if (target === undefined && change === undefined) throw new Error("a measured goal needs a target or a percent change");
    if (target !== undefined) out.target = target;
    else out.changePct = change;
    const baseline = g.baseline === undefined || g.baseline === null || g.baseline === "" ? existing?.baseline : Number(g.baseline);
    if (baseline !== undefined) out.baseline = baseline === null || Number.isFinite(baseline) ? baseline : null;
  }
  if (existing?.fromWeek !== undefined) out.fromWeek = existing.fromWeek;
  return out;
}
