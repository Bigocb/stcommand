/**
 * What a chart pays, measured from the books.
 *
 * Charting a waypoint pays a one-time credit reward (the API says "based on the rarity of the waypoint's traits") but
 * the amount is not in the spec and the chart call's reply is only the agent's balance. Every ledger row carries the
 * balance right after it (`wallet_after`), so between two consecutive rows the balance should move by exactly the
 * second row's own effect. Anything left over is credit the ledger didn't record; when a chart happened in that gap, the
 * leftover is its reward.
 *
 * Self-checking: gaps with no chart in them should leave exactly nothing over. `baseline` reports how often they do, so
 * a reader can tell whether the books are tight enough to trust the chart gaps.
 *
 * Pure: the caller passes the chart events and the ledger's balance track.
 */

export interface ChartEvent { at: number; ship: string; detail: string }
export interface WalletRow { at: number; type: string; total: number; walletAfter: number }

/** Credit effect of a row, or undefined when we can't tell from the type (ship purchases and scrap share a type). */
export function creditDelta(row: Pick<WalletRow, "type" | "total">): number | undefined {
  switch (row.type) {
    case "SELL": case "CONTRACT": return Math.abs(row.total);
    case "PURCHASE": case "REFUEL": case "JUMP": return -Math.abs(row.total);
    default: return undefined;
  }
}

export interface ChartGap {
  /** Credits the ledger didn't explain between the two rows. */
  unexplained: number;
  charts: ChartEvent[];
  gapMs: number;
}

export interface ChartRewardReport {
  charts: number;
  /** Gaps with no chart in them: how many, and how many explain to within `tolerance` credits. */
  baseline: { gaps: number; exact: number; exactShare: number | null };
  /** Gaps holding exactly one chart, whose leftover is that chart's reward. */
  single: { n: number; positive: number; median: number | null; mean: number | null; min: number | null; max: number | null };
  /** Gaps holding more than one chart: the leftover is their sum, spread evenly. */
  multi: { gaps: number; charts: number; perChart: number | null };
  /** The largest single-chart rewards with where they happened. */
  top: { ship: string; at: string; detail: string; reward: number }[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

export function chartGaps(rows: readonly WalletRow[], charts: readonly ChartEvent[]): { gaps: ChartGap[]; assigned: number } {
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const cs = [...charts].sort((a, b) => a.at - b.at);
  const gaps: ChartGap[] = [];
  let ci = 0;
  let assigned = 0;
  // Charts before the first row can't be bracketed.
  while (ci < cs.length && sorted.length && cs[ci]!.at <= sorted[0]!.at) ci++;
  for (let i = 1; i < sorted.length; i++) {
    const r1 = sorted[i - 1]!;
    const r2 = sorted[i]!;
    const delta = creditDelta(r2);
    const inGap: ChartEvent[] = [];
    while (ci < cs.length && cs[ci]!.at <= r2.at) { inGap.push(cs[ci]!); ci++; }
    if (delta === undefined) continue;
    assigned += inGap.length;
    gaps.push({ unexplained: r2.walletAfter - r1.walletAfter - delta, charts: inGap, gapMs: r2.at - r1.at });
  }
  return { gaps, assigned };
}

export function chartRewardReport(rows: readonly WalletRow[], charts: readonly ChartEvent[], opts: { tolerance?: number; top?: number } = {}): ChartRewardReport {
  const tol = opts.tolerance ?? 1;
  const { gaps } = chartGaps(rows, charts);
  const none = gaps.filter((g) => g.charts.length === 0);
  const exact = none.filter((g) => Math.abs(g.unexplained) <= tol).length;
  const one = gaps.filter((g) => g.charts.length === 1);
  const many = gaps.filter((g) => g.charts.length > 1);
  const vals = one.map((g) => g.unexplained);
  const manyCharts = many.reduce((s, g) => s + g.charts.length, 0);
  return {
    charts: charts.length,
    baseline: { gaps: none.length, exact, exactShare: none.length ? Math.round((exact / none.length) * 1000) / 1000 : null },
    single: {
      n: one.length,
      positive: vals.filter((v) => v > tol).length,
      median: median(vals),
      mean: vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
    },
    multi: { gaps: many.length, charts: manyCharts, perChart: manyCharts ? Math.round(many.reduce((s, g) => s + g.unexplained, 0) / manyCharts) : null },
    top: one
      .map((g) => ({ ship: g.charts[0]!.ship, at: new Date(g.charts[0]!.at).toISOString(), detail: g.charts[0]!.detail, reward: g.unexplained }))
      .sort((a, b) => b.reward - a.reward)
      .slice(0, opts.top ?? 10),
  };
}
