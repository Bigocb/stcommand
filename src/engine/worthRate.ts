/**
 * The fleet's rate in wallet plus holds, per hour.
 *
 * The trading pace (pace.ts) counts completed sales only, so it dips while traders carry cargo that has not sold yet and
 * jumps when it does. This reads the other side: the change in credits plus the estimated proceeds of every hold
 * (wealth_samples, one sample every five minutes), with hull purchases added back and scrap proceeds taken out, so
 * expanding the fleet does not read as a loss. Cargo counts at what it should fetch, so the figure includes profit that is
 * made but not yet realized, and falls if the estimates fall.
 *
 * Pure: no I/O, no clock, no globals. Samples are oldest first; a window with no sample near its start gives null.
 */
export interface WorthSample { ts: number; worth: number }
export interface HullFlow { ts: number; amount: number }

export interface WorthRate {
  /** Wallet plus holds now. */
  worth: number;
  /** Per hour over the last 60 minutes, hull purchases excluded; null when the samples do not cover the window. */
  perHour1h: number | null;
  /** The same over 3 hours. */
  perHour3h: number | null;
  /** Trailing-hour rate at the end of each of the last six 30-minute steps, oldest first (null where uncovered). */
  series: (number | null)[];
}

/** How far a sample may sit from the time asked for before it stops counting as "that time". */
const TOLERANCE_MS = 12 * 60_000;

function nearest(samples: readonly WorthSample[], t: number): WorthSample | undefined {
  let best: WorthSample | undefined;
  for (const s of samples) if (!best || Math.abs(s.ts - t) < Math.abs(best.ts - t)) best = s;
  return best && Math.abs(best.ts - t) <= TOLERANCE_MS ? best : undefined;
}

/** Rate over [endMs - hours, endMs]. */
export function rateBetween(samples: readonly WorthSample[], hull: readonly HullFlow[], endMs: number, hours: number): number | null {
  const startMs = endMs - hours * 3_600_000;
  const a = nearest(samples, startMs), b = nearest(samples, endMs);
  if (!a || !b || b.ts <= a.ts) return null;
  const flow = hull.filter((h) => h.ts > a.ts && h.ts <= b.ts).reduce((s, h) => s + h.amount, 0);
  const spanHours = (b.ts - a.ts) / 3_600_000;
  return Math.round((b.worth - a.worth + flow) / spanHours);
}

export function worthRate(samples: readonly WorthSample[], hull: readonly HullFlow[], nowMs: number): WorthRate | null {
  const latest = samples[samples.length - 1];
  if (!latest || nowMs - latest.ts > TOLERANCE_MS) return null;
  const series: (number | null)[] = [];
  for (let i = 5; i >= 0; i -= 1) series.push(rateBetween(samples, hull, latest.ts - i * 30 * 60_000, 1));
  return {
    worth: Math.round(latest.worth),
    perHour1h: rateBetween(samples, hull, latest.ts, 1),
    perHour3h: rateBetween(samples, hull, latest.ts, 3),
    series,
  };
}
