/**
 * What every API request was and how it went, kept as 5-minute buckets for a day, keyed `<role>:<call type>`
 * (for example `keeper:market`, `trader:navigate`).
 *
 * The rate limiter's own stats say who is waiting right now (last 5 minutes, per process). This keeps the longer view: calls a
 * minute, how long each kind waited for a token, how long the game took to answer, and how many answers were 429s, errors or
 * timeouts, so a change (a new rate, a released system, a parked keeper group) can be matched to what it did to each kind of call.
 *
 * Pure apart from the module-level instance: record() takes the time, summary() and series() take `now`. In memory only: a restart
 * empties it. Bounded: 288 buckets per key at most, and keys are role x call type (about 100).
 */
export interface ApiCallEvent {
  at: number;
  role: string;
  kind: string;
  /** Limiter priority the call asked for (0 boot .. 4 background). */
  priority: number;
  /** Time spent waiting for a token, ms. */
  waitMs: number;
  /** Time the game took to answer, ms (0 when the request never got an answer). */
  durationMs: number;
  /** HTTP status; 0 = no answer (timeout or network error). */
  status: number;
}

interface Agg {
  calls: number;
  waitTotal: number;
  waitMax: number;
  durTotal: number;
  durMax: number;
  ok: number;
  r429: number;
  err4xx: number;
  err5xx: number;
  noAnswer: number;
}

export interface ApiCallRow {
  /** `<role>:<call type>` */
  key: string;
  role: string;
  kind: string;
  calls: number;
  perMin: number;
  /** Share of all calls in the window, 0-1. */
  share: number;
  avgWaitMs: number;
  maxWaitMs: number;
  avgAnswerMs: number;
  maxAnswerMs: number;
  r429: number;
  /** Other 4xx, 5xx and requests that got no answer. */
  errors: number;
}

export interface ApiCallSummary {
  sinceMin: number;
  /** How much of the window the log actually covers (it starts empty after a restart). */
  coveredMin: number;
  calls: number;
  perMin: number;
  r429: number;
  errors: number;
  rows: ApiCallRow[];
}

const BUCKET_MS = 5 * 60_000;
const KEEP_BUCKETS = 288;

const blank = (): Agg => ({ calls: 0, waitTotal: 0, waitMax: 0, durTotal: 0, durMax: 0, ok: 0, r429: 0, err4xx: 0, err5xx: 0, noAnswer: 0 });

export class ApiCallLog {
  /** key -> bucket start (ms) -> aggregate */
  private readonly data = new Map<string, Map<number, Agg>>();
  private firstAt: number | undefined;

  record(e: ApiCallEvent): void {
    const key = `${e.role}:${e.kind}`;
    const start = Math.floor(e.at / BUCKET_MS) * BUCKET_MS;
    if (this.firstAt === undefined) this.firstAt = e.at;
    let byBucket = this.data.get(key);
    if (!byBucket) { byBucket = new Map(); this.data.set(key, byBucket); }
    let a = byBucket.get(start);
    if (!a) {
      a = blank();
      byBucket.set(start, a);
      if (byBucket.size > KEEP_BUCKETS) {
        const oldest = Math.min(...byBucket.keys());
        byBucket.delete(oldest);
      }
    }
    a.calls += 1;
    a.waitTotal += e.waitMs;
    a.waitMax = Math.max(a.waitMax, e.waitMs);
    a.durTotal += e.durationMs;
    a.durMax = Math.max(a.durMax, e.durationMs);
    if (e.status === 0) a.noAnswer += 1;
    else if (e.status === 429) a.r429 += 1;
    else if (e.status >= 500) a.err5xx += 1;
    else if (e.status >= 400) a.err4xx += 1;
    else a.ok += 1;
  }

  /** Calls grouped by role and call type over the last `sinceMin` minutes, busiest first. */
  summary(now: number, sinceMin = 60, filter: { role?: string; kind?: string } = {}, top = 40): ApiCallSummary {
    const cutoff = now - sinceMin * 60_000;
    const covered = this.firstAt === undefined ? 0 : Math.min(sinceMin, Math.max(0, (now - this.firstAt) / 60_000));
    const minutes = Math.max(covered, 1);
    const rows: ApiCallRow[] = [];
    let total = 0;
    let r429 = 0;
    let errors = 0;
    for (const [key, byBucket] of this.data) {
      const i = key.indexOf(":");
      const role = key.slice(0, i);
      const kind = key.slice(i + 1);
      if (filter.role && role !== filter.role) continue;
      if (filter.kind && kind !== filter.kind) continue;
      const a = blank();
      for (const [start, b] of byBucket) {
        if (start + BUCKET_MS <= cutoff) continue;
        a.calls += b.calls; a.waitTotal += b.waitTotal; a.waitMax = Math.max(a.waitMax, b.waitMax);
        a.durTotal += b.durTotal; a.durMax = Math.max(a.durMax, b.durMax);
        a.ok += b.ok; a.r429 += b.r429; a.err4xx += b.err4xx; a.err5xx += b.err5xx; a.noAnswer += b.noAnswer;
      }
      if (a.calls === 0) continue;
      const errs = a.err4xx + a.err5xx + a.noAnswer;
      total += a.calls; r429 += a.r429; errors += errs;
      rows.push({
        key, role, kind, calls: a.calls, perMin: round1(a.calls / minutes), share: 0,
        avgWaitMs: Math.round(a.waitTotal / a.calls), maxWaitMs: a.waitMax,
        avgAnswerMs: Math.round(a.durTotal / a.calls), maxAnswerMs: a.durMax,
        r429: a.r429, errors: errs,
      });
    }
    for (const r of rows) r.share = total ? Math.round((r.calls / total) * 1000) / 1000 : 0;
    rows.sort((x, y) => y.calls - x.calls);
    return { sinceMin, coveredMin: round1(covered), calls: total, perMin: round1(total / minutes), r429, errors, rows: rows.slice(0, Math.max(1, top)) };
  }

  /** One key (or every key of a role, or of a call type) over time, in `bucketMin` steps (a multiple of 5). */
  series(now: number, sinceMin: number, filter: { role?: string; kind?: string }, bucketMin = 15): { at: string; calls: number; perMin: number; avgWaitMs: number; r429: number; errors: number }[] {
    const step = Math.max(1, Math.round(bucketMin / 5)) * BUCKET_MS;
    const cutoff = now - sinceMin * 60_000;
    const out = new Map<number, Agg>();
    for (const [key, byBucket] of this.data) {
      const i = key.indexOf(":");
      if (filter.role && key.slice(0, i) !== filter.role) continue;
      if (filter.kind && key.slice(i + 1) !== filter.kind) continue;
      for (const [start, b] of byBucket) {
        if (start + BUCKET_MS <= cutoff) continue;
        const k = Math.floor(start / step) * step;
        const a = out.get(k) ?? blank();
        a.calls += b.calls; a.waitTotal += b.waitTotal; a.r429 += b.r429; a.err4xx += b.err4xx; a.err5xx += b.err5xx; a.noAnswer += b.noAnswer;
        out.set(k, a);
      }
    }
    return [...out.entries()].sort((x, y) => x[0] - y[0]).map(([k, a]) => ({
      at: new Date(k).toISOString(), calls: a.calls, perMin: round1(a.calls / (step / 60_000)),
      avgWaitMs: a.calls ? Math.round(a.waitTotal / a.calls) : 0, r429: a.r429, errors: a.err4xx + a.err5xx + a.noAnswer,
    }));
  }

  clear(): void { this.data.clear(); this.firstAt = undefined; }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The process-wide log every Client writes to. */
export const apiCallLog = new ApiCallLog();
