/**
 * Week over week: two weeks' ledger totals lined up by hours since each week's first trade, so "where were we at hour 48 last
 * week" has an answer (operator request, 2026-10-29). Pure: the store sums the ledger per hour, this lines the weeks up.
 *
 * The axis is hours since the week's first ledger row, not the server reset, because that is how the gate milestone is counted
 * (analysis `gateOpenHours`) and it works for any past week without knowing its reset time.
 */
export interface HourRow {
  /** Whole hours since the week's first ledger row. */
  hour: number;
  sells: number;
  /** Matched profit of this hour's sells (realized_pnl only). */
  pnl: number;
  revenue: number;
  /** Cargo bought this hour, credits. */
  purchases: number;
  /** Ships bought this hour (ledger SHIP rows). */
  ships: number;
  jumps: number;
  /** The wallet after this hour's last row that carried one; null when none did. */
  wallet: number | null;
}

export interface WeekSeries {
  /** For the dropdown and the legend, e.g. "THEOREM · 2026-10-18". */
  label: string;
  universeKey: string;
  startAt: string | null;
  /** Hours from the first trade to the first gate jump, the same stand-in for "gate open" for every past week. */
  firstJumpHour: number | null;
  hours: HourRow[];
}

export interface Point {
  hour: number;
  /** Matched profit so far. */
  cumPnl: number;
  /** Matched profit in this hour. */
  pnl: number;
  /** Wallet at the end of the hour, carried forward over hours with no reading. */
  wallet: number | null;
  /** Ships bought so far. */
  ships: number;
  /** Sells so far. */
  trades: number;
  /** Matched profit per hour averaged over this hour and the two before it (fewer at the start), to read a trend through the hour-to-hour noise. */
  rate: number;
}

/** One point per hour from 0 to `upToHour`, cumulative where a total is cumulative, wallet carried forward. */
export function toPoints(series: Pick<WeekSeries, "hours">, upToHour: number): Point[] {
  const byHour = new Map(series.hours.map((r) => [r.hour, r]));
  const out: Point[] = [];
  let cum = 0, ships = 0, trades = 0;
  let wallet: number | null = null;
  for (let h = 0; h <= upToHour; h++) {
    const r = byHour.get(h);
    if (r) { cum += r.pnl; ships += r.ships; trades += r.sells; if (r.wallet !== null) wallet = r.wallet; }
    out.push({ hour: h, cumPnl: Math.round(cum), pnl: Math.round(r?.pnl ?? 0), wallet, ships, trades, rate: 0 });
  }
  for (let i = 0; i < out.length; i++) {
    const from = Math.max(0, i - 2);
    let sum = 0;
    for (let j = from; j <= i; j++) sum += out[j]!.pnl;
    out[i]!.rate = Math.round(sum / (i - from + 1));
  }
  return out;
}

/**
 * The points a chart should draw: the hours after a week's last ledger row are blanked (null), so a week still in progress ends
 * where it is instead of falling to zero or running flat to the end of the axis. The checkpoint table reads the unblanked points.
 */
export function drawnPoints(points: readonly Point[], reached: number): (Point | { hour: number; cumPnl: null; pnl: null; wallet: null; ships: null; trades: null; rate: null })[] {
  return points.map((p) => (p.hour <= reached ? p : { hour: p.hour, cumPnl: null, pnl: null, wallet: null, ships: null, trades: null, rate: null }));
}

export const CHECKPOINT_HOURS = [6, 12, 24, 36, 48, 60, 72, 96, 120, 144, 167] as const;

export interface CheckpointRow {
  hour: number;
  a: Point | null;
  b: Point | null;
  /** a's cumulative matched profit minus b's; null when either week had not got that far. */
  pnlDelta: number | null;
}

/** The two weeks side by side at fixed hours; a week that had not reached an hour has null there. */
export function checkpoints(a: Point[], b: Point[], aReached: number, bReached: number, hours: readonly number[] = CHECKPOINT_HOURS): CheckpointRow[] {
  return hours.map((hour) => {
    const pa = hour <= aReached ? a[hour] ?? null : null;
    const pb = hour <= bReached ? b[hour] ?? null : null;
    return { hour, a: pa, b: pb, pnlDelta: pa && pb ? pa.cumPnl - pb.cumPnl : null };
  });
}

/** How far into the week the ledger reaches: its last hour with a row. */
export function hoursReached(series: Pick<WeekSeries, "hours">): number {
  return series.hours.reduce((m, r) => Math.max(m, r.hour), 0);
}

export interface WeekTotals {
  hoursReached: number;
  matchedPnl: number;
  pnlPerHour: number;
  trades: number;
  ships: number;
  jumps: number;
  bestHourPnl: number;
  endWallet: number | null;
}

export function weekTotals(series: Pick<WeekSeries, "hours">): WeekTotals {
  const reached = hoursReached(series);
  const pnl = series.hours.reduce((s, r) => s + r.pnl, 0);
  const wallet = [...series.hours].sort((x, y) => y.hour - x.hour).find((r) => r.wallet !== null)?.wallet ?? null;
  return {
    hoursReached: reached,
    matchedPnl: Math.round(pnl),
    pnlPerHour: reached > 0 ? Math.round(pnl / reached) : 0,
    trades: series.hours.reduce((s, r) => s + r.sells, 0),
    ships: series.hours.reduce((s, r) => s + r.ships, 0),
    jumps: series.hours.reduce((s, r) => s + r.jumps, 0),
    bestHourPnl: Math.round(series.hours.reduce((m, r) => Math.max(m, r.pnl), 0)),
    endWallet: wallet,
  };
}

/**
 * The like-for-like totals: both weeks cut at the hour the shorter one reached, so a week in progress is not set against a
 * finished one's full run.
 */
export function likeForLike(a: Pick<WeekSeries, "hours">, b: Pick<WeekSeries, "hours">): { hours: number; a: WeekTotals; b: WeekTotals } {
  const hours = Math.min(hoursReached(a), hoursReached(b));
  const cut = (s: Pick<WeekSeries, "hours">) => ({ hours: s.hours.filter((r) => r.hour <= hours) });
  return { hours, a: weekTotals(cut(a)), b: weekTotals(cut(b)) };
}

export const GATE_CHECKPOINT_HOURS = [6, 12, 24, 36, 48, 72, 96] as const;

export interface GateWindow {
  /** Matched profit before the gate's first jump hour. */
  beforePnl: number;
  /** Matched profit in the `hours` after it. */
  pnl: number;
  pnlPerHour: number;
  sells: number;
  ships: number;
}

export interface GateAligned {
  /** Hours after the gate that BOTH weeks have reached; the window every figure below covers. */
  hours: number;
  a: GateWindow;
  b: GateWindow;
  /** Matched profit since the gate opened, at hours after it. */
  checkpoints: { hour: number; a: number | null; b: number | null; delta: number | null }[];
}

/**
 * The two weeks lined up on the hour each one's gate opened (its first gate jump) instead of on the first trade, so a week whose
 * gate opened a day later is not marked down for the wait. Every figure after the gate covers the same number of hours, the
 * shorter of what the two weeks have had since their gates. Undefined when either week has no gate jump yet or has not run past it.
 */
export function gateAligned(a: Pick<WeekSeries, "hours" | "firstJumpHour">, b: Pick<WeekSeries, "hours" | "firstJumpHour">): GateAligned | undefined {
  if (a.firstJumpHour === null || a.firstJumpHour === undefined || b.firstJumpHour === null || b.firstJumpHour === undefined) return undefined;
  const ga = a.firstJumpHour, gb = b.firstJumpHour;
  const k = Math.min(hoursReached(a) - ga, hoursReached(b) - gb);
  if (k <= 0) return undefined;
  const win = (s: Pick<WeekSeries, "hours">, g: number): GateWindow => {
    let before = 0, pnl = 0, sells = 0, ships = 0;
    for (const r of s.hours) {
      if (r.hour < g) before += r.pnl;
      else if (r.hour < g + k) { pnl += r.pnl; sells += r.sells; ships += r.ships; }
    }
    return { beforePnl: Math.round(before), pnl: Math.round(pnl), pnlPerHour: Math.round(pnl / k), sells, ships };
  };
  const since = (pts: Point[], g: number, h: number): number => {
    const end = pts[g + h - 1], start = g > 0 ? pts[g - 1] : undefined;
    return end ? end.cumPnl - (start?.cumPnl ?? 0) : 0;
  };
  const pa = toPoints(a, ga + k), pb = toPoints(b, gb + k);
  return {
    hours: k,
    a: win(a, ga),
    b: win(b, gb),
    checkpoints: GATE_CHECKPOINT_HOURS.filter((h) => h <= k).map((hour) => {
      const x = since(pa, ga, hour), y = since(pb, gb, hour);
      return { hour, a: x, b: y, delta: x - y };
    }),
  };
}
