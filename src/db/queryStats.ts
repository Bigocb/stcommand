/**
 * Time and rows per database query shape, over a rolling window (issue #88 P0): which queries the fleet's time goes into,
 * before deciding what to cache. Read with ops db_queries.
 *
 * Why: on 2026-11-27 trade tasks spent 12-25% and keeper tasks about 19% of their time holding a database connection, but the
 * timer (stepTiming's db.query) could not say which query. A query is labelled by its SQL with literals and parameters folded,
 * cut to 120 characters, so the same statement with different values is one row.
 *
 * Pure store (the clock comes in); pool.ts feeds it. In memory on purpose: a diagnostic, rebuilt after a restart.
 */
export interface QuerySample { at: number; label: string; ms: number; rows: number }

export interface QueryRow {
  label: string;
  calls: number;
  perMin: number;
  totalMs: number;
  avgMs: number;
  p90Ms: number;
  maxMs: number;
  avgRows: number;
  /** Share of all query time in the window, 0-100. */
  sharePct: number;
}

const SKIP = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i;

/** The query's shape: whitespace collapsed, $n, numbers and quoted strings folded, at most 120 characters. Undefined = skip it. */
export function queryLabel(sql: unknown): string | undefined {
  const text = typeof sql === "string" ? sql : sql && typeof sql === "object" && typeof (sql as { text?: unknown }).text === "string" ? (sql as { text: string }).text : undefined;
  if (!text) return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  if (SKIP.test(t)) return undefined;
  return t.replace(/'(?:[^']|'')*'/g, "?").replace(/\$\d+/g, "?").replace(/\b\d+(\.\d+)?\b/g, "?").slice(0, 120);
}

export class QueryStats {
  private samples: QuerySample[] = [];
  constructor(private readonly keepMs = 60 * 60_000, private readonly maxSamples = 300_000) {}

  /** Index of the oldest live sample: dropping from the front only moves this, and the array is compacted now and then. */
  private head = 0;

  /**
   * O(1) amortized. The first version spliced the front of the array on every record once it held maxSamples (300,000):
   * at about 9,000 queries a minute that copy was 23% of the process's CPU on 2026-11-27 23:45 (box at 104%).
   */
  record(s: QuerySample): void {
    this.samples.push(s);
    const len = this.samples.length;
    if (len - this.head > this.maxSamples) this.head = len - this.maxSamples;
    const cut = s.at - this.keepMs;
    while (this.head < len && this.samples[this.head]!.at < cut) this.head++;
    if (this.head >= 50_000 && this.head * 2 >= len) {
      this.samples = this.samples.slice(this.head);
      this.head = 0;
    }
  }

  /** Live samples (oldest first). */
  private live(): QuerySample[] {
    return this.head === 0 ? this.samples : this.samples.slice(this.head);
  }

  summary(now: number, windowMs: number, top = 25): { windowMin: number; coveredMin: number; calls: number; totalMs: number; queries: QueryRow[] } {
    const from = now - windowMs;
    const inWin = this.live().filter((s) => s.at >= from);
    const covered = inWin[0] ? Math.max(1, (now - inWin[0].at) / 60_000) : 1;
    const by = new Map<string, QuerySample[]>();
    for (const s of inWin) (by.get(s.label) ?? by.set(s.label, []).get(s.label)!).push(s);
    const total = inWin.reduce((t, s) => t + s.ms, 0);
    const rows: QueryRow[] = [...by.entries()].map(([label, xs]) => {
      const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
      const sum = ms.reduce((t, v) => t + v, 0);
      return {
        label, calls: xs.length, perMin: Math.round((xs.length / covered) * 10) / 10, totalMs: Math.round(sum),
        avgMs: Math.round((sum / xs.length) * 10) / 10, p90Ms: Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))]!),
        maxMs: Math.round(ms[ms.length - 1]!), avgRows: Math.round(xs.reduce((t, x) => t + x.rows, 0) / xs.length),
        sharePct: total > 0 ? Math.round((sum / total) * 1000) / 10 : 0,
      };
    });
    rows.sort((a, b) => b.totalMs - a.totalMs);
    return { windowMin: Math.round(windowMs / 60_000), coveredMin: Math.round(Math.min(covered, windowMs / 60_000)), calls: inWin.length, totalMs: Math.round(total), queries: rows.slice(0, top) };
  }
}

export const queryStats = new QueryStats();
