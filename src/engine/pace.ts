/**
 * Trading pace: realized profit on completed sales, minus fuel and jump costs, per hour. Cargo bought but not yet sold
 * and ship purchases do not count, so the figure doesn't dip when traders load up or you expand the fleet. It equals
 * the change in (wallet + holds valued at cost), ships excluded.
 *
 * Input is equal-width buckets, oldest first, the last one ending now.
 */
export interface Pace {
  /** Last 60 minutes, per hour. */
  perHour1h: number;
  /** Last 3 hours, per hour. */
  perHour3h: number;
  /** The whole window, per hour. */
  perHourWindow: number;
  /** Trailing-60-minute rate at each bucket end from the 4th bucket on, per hour. */
  series: number[];
  bucketMinutes: number;
}

export function paceFromBuckets(buckets: readonly number[], bucketMinutes: number): Pace {
  const perHourFactor = 60 / bucketMinutes; // buckets per hour
  const sum = (from: number, to: number): number => buckets.slice(Math.max(0, from), to).reduce((s, v) => s + v, 0);
  const n = buckets.length;
  const hours = (count: number): number => Math.min(count, n) / perHourFactor;
  const last = (count: number): number => {
    const h = hours(count);
    return h > 0 ? Math.round(sum(n - count, n) / h) : 0;
  };
  const series: number[] = [];
  for (let i = perHourFactor - 1; i < n; i += 1) series.push(Math.round(sum(i - perHourFactor + 1, i + 1)));
  return {
    perHour1h: last(perHourFactor),
    perHour3h: last(perHourFactor * 3),
    perHourWindow: n ? Math.round(sum(0, n) / (n / perHourFactor)) : 0,
    series,
    bucketMinutes,
  };
}
