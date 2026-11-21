// Rate-based keeper market reads: the operator picks a pass time, this module turns it into reads a minute.
//
// Before (2026-11-21): keeper reads came from N lane workers running keeper ship tasks, so the read rate was whatever those
// workers managed (~40 a minute for 1,600-1,700 keepers) and the pass time (keeper_coverage rotationMin, 30-60 min) fell out of
// it, while 15 proxy lanes at 90 a minute each sat nearly idle. Here the pass time is the input: every keeper market is due once
// per `targetPassMin` (or its own override interval), the planned rate is the sum of 1/interval over the markets, capped by what
// the proxy lanes can carry and by a ceiling, and each tick picks the most overdue markets up to that tick's share of the rate.
//
// Pure: no I/O, no clock, no globals. The caller passes the time, the markets and the capacity, and keeps `carry` between ticks.

export interface KeeperReadMarket {
  /** The market's waypoint; a keeper ship is in place there (docked or in orbit), so a read returns its prices. */
  waypoint: string;
  /** When any read of this market last landed (epoch ms); undefined = never read. */
  lastReadMs?: number;
}

/** Per-market read interval in ms (a tiering module supplies it); undefined or not positive = the target pass time. */
export type IntervalOverride = ReadonlyMap<string, number> | ((waypoint: string) => number | undefined);

export interface KeeperReadPolicy {
  /** Off = pick nothing (the keeper ship tasks read their markets themselves, as before). */
  enabled: boolean;
  /** Minutes one pass over every keeper market should take. */
  targetPassMin: number;
  /** Hard cap on scheduled reads a minute, whatever the lanes could carry. */
  ceilingPerMin: number;
  /** Most reads in flight at once; 0 = no cap beyond the tick's quota. */
  maxInFlight: number;
}

export interface KeeperReadInput {
  markets: readonly KeeperReadMarket[];
  nowMs: number;
  /** Reads a minute the active proxy lanes can give keeper reads (after headroom for their other traffic); 0 = no lane. */
  laneCapacityPerMin: number;
  /** Waypoints whose read was issued and has not finished: never picked again, and they count against maxInFlight. */
  inFlight: ReadonlySet<string>;
  /** Milliseconds since the previous tick (the share of the per-minute rate this tick may issue). */
  elapsedMs: number;
  /** Fraction of a read left over from earlier ticks, so a rate under one a tick still adds up (start at 0). */
  carry: number;
  intervals?: IntervalOverride;
}

export type KeeperReadLimit = "off" | "no-lane" | "demand" | "capacity" | "ceiling";

export interface KeeperReadPlan {
  /** Markets to read now, most overdue first. */
  read: string[];
  /** Reads a minute the target pass time asks for (sum of 1/interval). */
  demandPerMin: number;
  /** Reads a minute actually planned: min(demand, lane capacity, ceiling). */
  plannedPerMin: number;
  /** Minutes one pass takes at the planned rate (undefined with no markets or no rate). */
  projectedPassMin?: number;
  /** Markets past their interval now (including the ones picked). */
  due: number;
  /** What sets the rate. */
  limitedBy: KeeperReadLimit;
  /** Carry for the next tick. */
  carry: number;
  reason: string;
}

export const DEFAULT_KEEPER_READ_POLICY: KeeperReadPolicy = { enabled: false, targetPassMin: 30, ceilingPerMin: 300, maxInFlight: 0 };

function intervalOf(waypoint: string, targetMs: number, intervals?: IntervalOverride): number {
  const v = intervals === undefined ? undefined : typeof intervals === "function" ? intervals(waypoint) : intervals.get(waypoint);
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : targetMs;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Which keeper markets to read this tick, and at what rate. */
export function planKeeperReads(input: KeeperReadInput, policy: KeeperReadPolicy): KeeperReadPlan {
  const none = (limitedBy: KeeperReadLimit, reason: string, demandPerMin = 0, due = 0): KeeperReadPlan =>
    ({ read: [], demandPerMin: round1(demandPerMin), plannedPerMin: 0, due, limitedBy, carry: 0, reason });
  if (!policy.enabled) return none("off", "keeper read scheduler off: keeper ships read their own markets");
  const targetMs = Math.max(1, policy.targetPassMin) * 60_000;

  let demandPerMin = 0;
  const due: { waypoint: string; overdueMs: number; ratio: number }[] = [];
  for (const m of input.markets) {
    const interval = intervalOf(m.waypoint, targetMs, input.intervals);
    demandPerMin += 60_000 / interval;
    const age = m.lastReadMs === undefined ? Number.POSITIVE_INFINITY : input.nowMs - m.lastReadMs;
    if (age >= interval) due.push({ waypoint: m.waypoint, overdueMs: age - interval, ratio: age / interval });
  }
  if (input.markets.length === 0) return none("demand", "no keeper in place at its market");
  if (!(input.laneCapacityPerMin > 0)) return none("no-lane", "no proxy lane capacity: keeper ships read their own markets", demandPerMin, due.length);

  const ceiling = Math.max(0, policy.ceilingPerMin);
  let plannedPerMin = demandPerMin;
  let limitedBy: KeeperReadLimit = "demand";
  if (input.laneCapacityPerMin < plannedPerMin) { plannedPerMin = input.laneCapacityPerMin; limitedBy = "capacity"; }
  if (ceiling < plannedPerMin) { plannedPerMin = ceiling; limitedBy = "ceiling"; }

  // This tick's share of the rate, plus what earlier ticks left over. The carry is capped at a few reads so a quiet spell
  // (nothing due) does not bank a burst for later.
  const budget = Math.min(input.carry + (plannedPerMin * Math.max(0, input.elapsedMs)) / 60_000, Math.max(4, plannedPerMin / 6));
  let quota = Math.floor(budget);
  if (policy.maxInFlight > 0) quota = Math.min(quota, Math.max(0, policy.maxInFlight - input.inFlight.size));

  // Most overdue first: never read, then by how far past its interval (as a share of it, so a short-interval market
  // is not starved by a long-interval one), then by name for a stable order.
  due.sort((a, b) => b.ratio - a.ratio || b.overdueMs - a.overdueMs || a.waypoint.localeCompare(b.waypoint));
  const read: string[] = [];
  for (const d of due) {
    if (read.length >= quota) break;
    if (input.inFlight.has(d.waypoint)) continue;
    read.push(d.waypoint);
  }
  const carry = due.length > read.length ? Math.max(0, budget - read.length) : 0;
  const projectedPassMin = plannedPerMin > 0 ? round1(input.markets.length / plannedPerMin) : undefined;
  const why = limitedBy === "demand" ? `target ${policy.targetPassMin} min` : limitedBy === "capacity" ? `lane capacity ${round1(input.laneCapacityPerMin)}/min` : `ceiling ${ceiling}/min`;
  const reason = `${read.length} read(s) of ${due.length} due; ${input.markets.length} keeper markets at ${round1(plannedPerMin)}/min (${why}; demand ${round1(demandPerMin)}/min), pass ~${projectedPassMin ?? "?"} min`;
  return { read, demandPerMin: round1(demandPerMin), plannedPerMin: round1(plannedPerMin), projectedPassMin, due: due.length, limitedBy, carry, reason };
}

/**
 * Whether a keeper ship should skip its own read of this market because the scheduler covers it: only while the scheduler is
 * on and has lane capacity, and only while the market's last read is younger than its interval with some slack (so a market
 * the scheduler falls behind on is still read by its keeper, as before).
 */
export function keeperShipSkipsRead(opts: { schedulerActive: boolean; lastReadMs?: number; nowMs: number; intervalMs: number; slack?: number }): boolean {
  if (!opts.schedulerActive || opts.lastReadMs === undefined) return false;
  return opts.nowMs - opts.lastReadMs < opts.intervalMs * (opts.slack ?? 1.5);
}
