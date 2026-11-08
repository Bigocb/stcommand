/**
 * What the proxy plan has used, kept across restarts (operator, 2026-11-08: "Do you think I want things only in memory?").
 *
 * The plan is billed in bytes for a month (250 GB, renewing on the 7th at 17:32 UTC), and the in-memory ByteMeter (lanePool.ts) forgets everything
 * when the box restarts, so it can say what the last half hour looked like but not what the month has cost. This keeps a ledger of
 * response bytes by UTC day, lane (host:port, or "box") and call kind: counted in memory as calls finish, written to the database
 * every minute as increments (migration 067), and read back for the billing period. Writes that fail are put back and tried again,
 * so a database blip loses nothing and a crash loses at most the last minute.
 *
 * Pure: no I/O and no clock (callers pass times). Counts response bytes only, as ByteMeter does; the provider's own dashboard is the
 * authority and also counts requests, headers and handshakes, so compare the two over the same hours (docs/api-lanes-pool-plan.md).
 */

export interface LaneByteRow {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** host:port of the proxy (never credentials), or "box". */
  label: string;
  kind: string;
  calls: number;
  bytes: number;
}

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export class ByteLedger {
  private pending = new Map<string, LaneByteRow>();

  record(at: number, label: string, kind: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.add({ day: dayOf(at), label, kind, calls: 1, bytes });
  }

  private add(r: LaneByteRow): void {
    const k = `${r.day}|${r.label}|${r.kind}`;
    const cur = this.pending.get(k);
    if (cur) { cur.calls += r.calls; cur.bytes += r.bytes; } else this.pending.set(k, { ...r });
  }

  /** Everything counted since the last drain, which is cleared. */
  drain(): LaneByteRow[] {
    const rows = [...this.pending.values()];
    this.pending = new Map();
    return rows;
  }

  /** Put rows back after a failed write, merged with anything counted since. */
  restore(rows: LaneByteRow[]): void {
    for (const r of rows) this.add(r);
  }

  /** What is waiting to be written, without clearing it (so a report can include the last minute). */
  peek(): LaneByteRow[] {
    return [...this.pending.values()].map((r) => ({ ...r }));
  }
}

export interface BillingPeriod {
  /** First instant of the period (UTC midnight of the reset day). */
  start: Date;
  /** First instant of the next period. */
  end: Date;
}

/** Days in a UTC month (month is 0-11). */
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The reset day clamped into a month that may be shorter (the 31st in February is the 28th). */
const resetIn = (y: number, m: number, day: number): Date => new Date(Date.UTC(y, m, Math.min(Math.max(1, Math.floor(day)), daysIn(y, m))));

/** The monthly period containing `now` for a plan that renews on `resetDay` of each month, UTC. */
export function billingPeriod(now: number, resetDay: number): BillingPeriod {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const thisReset = resetIn(y, m, resetDay);
  if (now >= thisReset.getTime()) return { start: thisReset, end: resetIn(m === 11 ? y + 1 : y, (m + 1) % 12, resetDay) };
  return { start: resetIn(m === 0 ? y - 1 : y, (m + 11) % 12, resetDay), end: thisReset };
}

export interface PeriodReport {
  periodStart: string;
  periodEnd: string;
  /** Days of the period gone, fractional. */
  daysElapsed: number;
  daysInPeriod: number;
  /** Response GB counted since the period began (1e9 bytes). */
  usedGB: number;
  /** usedGB carried to the end of the period at its average rate so far. */
  projectedGB: number;
  planGB: number;
  /** usedGB as a share of the plan, 0-1. */
  usedShare: number;
  projectedShare: number;
  /** Lane (host:port or "box") -> GB used and calls, biggest first. */
  byLabel: { label: string; gb: number; calls: number }[];
  /** Call kind -> calls and average response bytes, biggest by bytes first. */
  byKind: { kind: string; calls: number; avgBytes: number; gb: number }[];
  /** First day with any stored bytes in the period (YYYY-MM-DD), or null. The ledger only counts from when it was first switched on. */
  dataStartsOn: string | null;
  /** Set when the stored data starts after the period does: the projection then averages over the whole period and is understated. */
  projectionNote?: string;
  /** Days with data in the period, oldest first, GB through proxies (not the box). */
  byDay: { day: string; proxyGB: number; boxGB: number }[];
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The period's use from the stored rows (any rows outside it are ignored). */
export function periodReport(rows: LaneByteRow[], period: BillingPeriod, now: number, planGB: number): PeriodReport {
  const startDay = period.start.toISOString().slice(0, 10);
  const endDay = period.end.toISOString().slice(0, 10);
  const inPeriod = rows.filter((r) => r.day >= startDay && r.day < endDay);
  const labels = new Map<string, { bytes: number; calls: number }>();
  const kinds = new Map<string, { bytes: number; calls: number }>();
  const days = new Map<string, { proxy: number; box: number }>();
  let total = 0;
  for (const r of inPeriod) {
    total += r.bytes;
    const l = labels.get(r.label) ?? { bytes: 0, calls: 0 }; l.bytes += r.bytes; l.calls += r.calls; labels.set(r.label, l);
    if (r.label !== "box") {
      const k = kinds.get(r.kind) ?? { bytes: 0, calls: 0 }; k.bytes += r.bytes; k.calls += r.calls; kinds.set(r.kind, k);
    }
    const d = days.get(r.day) ?? { proxy: 0, box: 0 };
    if (r.label === "box") d.box += r.bytes; else d.proxy += r.bytes;
    days.set(r.day, d);
  }
  // The plan counts proxy traffic only; the box's own bytes are shown but kept out of the plan figures.
  const proxyBytes = inPeriod.filter((r) => r.label !== "box").reduce((s, r) => s + r.bytes, 0);
  const msPeriod = period.end.getTime() - period.start.getTime();
  const daysInPeriod = msPeriod / 86_400_000;
  const daysElapsed = Math.min(daysInPeriod, Math.max(0, (now - period.start.getTime()) / 86_400_000));
  // Too little of the period gone makes the average meaningless; say nothing rather than a wild number.
  const projected = daysElapsed >= 0.05 ? (proxyBytes / daysElapsed) * daysInPeriod : 0;
  const gb = (b: number): number => b / 1e9;
  const dataStartsOn = inPeriod.length ? inPeriod.reduce((m, r) => (r.day < m ? r.day : m), inPeriod[0]!.day) : null;
  const projectionNote = dataStartsOn && dataStartsOn > startDay
    ? `stored bytes start on ${dataStartsOn}, after the period began on ${startDay}: the projection averages over the whole period and is understated until a day or two of data has built up; the provider's own projection is the better figure meanwhile`
    : undefined;
  return {
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    daysElapsed: r1(daysElapsed),
    daysInPeriod: Math.round(daysInPeriod),
    usedGB: r3(gb(proxyBytes)),
    projectedGB: r1(gb(projected)),
    planGB,
    usedShare: planGB ? r3(gb(proxyBytes) / planGB) : 0,
    projectedShare: planGB ? r3(gb(projected) / planGB) : 0,
    dataStartsOn,
    ...(projectionNote ? { projectionNote } : {}),
    byLabel: [...labels.entries()].map(([label, v]) => ({ label, gb: r3(gb(v.bytes)), calls: v.calls })).sort((a, b) => b.gb - a.gb),
    byKind: [...kinds.entries()].map(([kind, v]) => ({ kind, calls: v.calls, avgBytes: v.calls ? Math.round(v.bytes / v.calls) : 0, gb: r3(gb(v.bytes)) })).sort((a, b) => b.gb - a.gb),
    byDay: [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => ({ day, proxyGB: r3(gb(v.proxy)), boxGB: r3(gb(v.box)) })),
  };
}

/** The plan size and renewal day from the environment: API_LANE_PLAN_GB (default 250) and API_LANE_PLAN_RESET_DAY (default 7); both read from the Webshare subscription on 2026-11-08 (plan 14802851: 250 GB, term 2026-11-07 17:32 to 2026-12-07 17:32 UTC). Usage is kept by UTC day, so the period starts on the reset day's midnight, about 17 hours early. */
export function planFromEnv(env: Record<string, string | undefined>): { planGB: number; resetDay: number } {
  const gb = Number(env.API_LANE_PLAN_GB);
  const day = Number(env.API_LANE_PLAN_RESET_DAY);
  return { planGB: Number.isFinite(gb) && gb > 0 ? gb : 250, resetDay: Number.isFinite(day) && day >= 1 && day <= 31 ? Math.floor(day) : 7 };
}
