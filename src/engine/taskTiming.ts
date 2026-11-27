/**
 * How long scheduler tasks hold a worker, and where that time goes (issue #66).
 *
 * In 2026-11-21's numbers 12 keeper lane workers managed only ~40 market reads a minute, so each keeper task held a
 * worker for ~15-18 s while its API wait was ~0.1-0.4 s. This window keeps the last few minutes of task timings (from
 * `StepTimer`, src/core/stepTiming.ts) per task kind and splits the average held time into API wait, API request, API
 * backoff, DB pool wait, DB queries and other, so the missing seconds can be named.
 *
 * Pure: no I/O, no clock (the caller passes `at`/`now`). A diagnostic cache, rebuilt from nothing after a restart:
 * nothing decides from it.
 */

export interface TaskTimingSample {
  at: number;
  /** Task kind: the last part of the task id ("keeper", "mine", "tour", ...). */
  kind: string;
  totalMs: number;
  steps: Record<string, number>;
  counts: Record<string, number>;
  /** How long the task waited to start after it came due (start time minus earliestRunAt), ms; undefined = not measured. */
  queueMs?: number;
}

export interface TaskTimingSummary {
  kind: string;
  tasks: number;
  windowMin: number;
  avgHeldMs: number;
  p90HeldMs: number;
  maxHeldMs: number;
  /** Average ms per task for each noted step, plus `other` (held time no step accounts for, never below 0). */
  avgStepMs: Record<string, number>;
  /** Average number of times each step was noted per task (API requests, DB checkouts, ...). */
  avgStepCount: Record<string, number>;
  /** Each step's share of the held time, 0-100. */
  sharePct: Record<string, number>;
  /** Wait between coming due and starting (issue #88 P0): what a concurrent scheduler would win back. */
  avgQueueMs?: number;
  p90QueueMs?: number;
  maxQueueMs?: number;
}

/** The task kind for a scheduler task id: `THEO-1A-keeper` -> `keeper`. */
export function taskKind(taskId: string): string {
  const i = taskId.lastIndexOf("-");
  return i >= 0 ? taskId.slice(i + 1) : taskId;
}

const round = (n: number, places = 0): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export class TaskTimingWindow {
  private samples: TaskTimingSample[] = [];

  constructor(private readonly windowMs = 10 * 60_000, private readonly maxSamples = 5_000) {}

  note(sample: TaskTimingSample): void {
    this.samples.push(sample);
    this.prune(sample.at);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.at < cutoff) drop += 1;
    if (this.samples.length - drop > this.maxSamples) drop = this.samples.length - this.maxSamples;
    if (drop > 0) this.samples.splice(0, drop);
  }

  /** One summary per task kind seen in the window, the kind holding workers longest in total first. */
  summary(now: number, kind?: string): TaskTimingSummary[] {
    this.prune(now);
    const byKind = new Map<string, TaskTimingSample[]>();
    for (const s of this.samples) {
      if (kind && s.kind !== kind) continue;
      const list = byKind.get(s.kind);
      if (list) list.push(s);
      else byKind.set(s.kind, [s]);
    }
    return [...byKind.entries()]
      .map(([k, list]) => summarize(k, list, this.windowMs))
      .sort((a, b) => b.avgHeldMs * b.tasks - a.avgHeldMs * a.tasks);
  }
}

/** Summarize one kind's samples. Exported for tests. */
export function summarize(kind: string, list: TaskTimingSample[], windowMs: number): TaskTimingSummary {
  const n = list.length;
  const held = list.map((s) => s.totalMs).sort((a, b) => a - b);
  const sumHeld = held.reduce((t, v) => t + v, 0);
  const stepTotals: Record<string, number> = {};
  const countTotals: Record<string, number> = {};
  let other = 0;
  for (const s of list) {
    let accounted = 0;
    for (const [k, v] of Object.entries(s.steps)) {
      stepTotals[k] = (stepTotals[k] ?? 0) + v;
      accounted += v;
    }
    for (const [k, v] of Object.entries(s.counts)) countTotals[k] = (countTotals[k] ?? 0) + v;
    other += Math.max(0, s.totalMs - accounted);
  }
  stepTotals.other = other;
  const avgStepMs: Record<string, number> = {};
  const sharePct: Record<string, number> = {};
  for (const k of Object.keys(stepTotals).sort()) {
    avgStepMs[k] = n ? round(stepTotals[k]! / n) : 0;
    sharePct[k] = sumHeld > 0 ? round((stepTotals[k]! / sumHeld) * 100, 1) : 0;
  }
  const avgStepCount: Record<string, number> = {};
  for (const k of Object.keys(countTotals).sort()) avgStepCount[k] = n ? round(countTotals[k]! / n, 1) : 0;
  const queued = list.map((s) => s.queueMs).filter((q): q is number => q !== undefined).sort((a, b) => a - b);
  const queue = queued.length
    ? { avgQueueMs: round(queued.reduce((t, v) => t + v, 0) / queued.length), p90QueueMs: queued[Math.min(queued.length - 1, Math.floor(queued.length * 0.9))]!, maxQueueMs: queued[queued.length - 1]! }
    : {};
  return {
    kind,
    tasks: n,
    windowMin: round(windowMs / 60_000, 1),
    avgHeldMs: n ? round(sumHeld / n) : 0,
    p90HeldMs: n ? held[Math.min(n - 1, Math.floor(n * 0.9))]! : 0,
    maxHeldMs: n ? held[n - 1]! : 0,
    avgStepMs,
    avgStepCount,
    sharePct,
    ...queue,
  };
}

/** One log line: `keeper tasks 412 in 10m: held avg 15.2s p90 21.0s · db.wait 9.8s (64%) · db.query 3.1s (20%) · ...`. */
export function describeTiming(s: TaskTimingSummary): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const steps = Object.entries(s.avgStepMs)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${sec(v)} (${s.sharePct[k] ?? 0}%${s.avgStepCount[k] !== undefined ? `, ${s.avgStepCount[k]}x` : ""})`);
  return `${s.kind} tasks ${s.tasks} in ${s.windowMin}m: held avg ${sec(s.avgHeldMs)} p90 ${sec(s.p90HeldMs)} max ${sec(s.maxHeldMs)} · ${steps.join(" · ")}`;
}
