/**
 * How often markets actually change, per hour (operator question 2026-11-19: why did keepers slow to one read every 30 minutes
 * through the crash?). A keeper waits a third of the time since its market last changed (keeperCadence.ts), so a fleet of
 * keepers on the slowest cadence means either the markets really sat still or the changes were not seen. This counts, from the
 * stored snapshots, how many reads each market had in each bucket and how many of those reads differed from the read before
 * (any good's buy price, sell price or supply).
 *
 * Pure: the store does the per-read comparison (LAG over each market and good) and hands over one row per market and bucket.
 */

export type MarketChangeRow = {
  waypoint: string;
  /** Bucket start, ms since the epoch. */
  bucket: number;
  /** Distinct snapshot times of this market in the bucket. */
  reads: number;
  /** Of those, the reads where at least one good differed from its previous read. */
  changed: number;
};

export type MarketChangeBucket = {
  at: string;
  /** Markets with at least one read in the bucket. */
  markets: number;
  reads: number;
  changedReads: number;
  /** Markets with at least one change in the bucket. */
  marketsChanged: number;
  /** changedReads / reads, in percent (null with no reads). */
  changedPct: number | null;
};

export type MarketChangeReport = {
  buckets: MarketChangeBucket[];
  /** Markets read in the window that never changed once. */
  neverChanged: number;
  marketsSeen: number;
  /** The markets with the most changes, for a spot check. */
  busiest: { waypoint: string; reads: number; changed: number }[];
  reading: string;
};

export function summarizeMarketChanges(rows: readonly MarketChangeRow[], only?: ReadonlySet<string>, top = 10): MarketChangeReport {
  const use = only ? rows.filter((r) => only.has(r.waypoint)) : rows;
  const byBucket = new Map<number, MarketChangeRow[]>();
  const byMarket = new Map<string, { reads: number; changed: number }>();
  for (const r of use) {
    byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r]);
    const m = byMarket.get(r.waypoint) ?? { reads: 0, changed: 0 };
    m.reads += r.reads; m.changed += r.changed;
    byMarket.set(r.waypoint, m);
  }
  const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([at, list]) => {
    const reads = list.reduce((t, r) => t + r.reads, 0);
    const changedReads = list.reduce((t, r) => t + r.changed, 0);
    return {
      at: new Date(at).toISOString(), markets: list.length, reads, changedReads,
      marketsChanged: list.filter((r) => r.changed > 0).length,
      changedPct: reads ? Math.round((changedReads / reads) * 1000) / 10 : null,
    };
  });
  const neverChanged = [...byMarket.values()].filter((m) => m.changed === 0).length;
  const busiest = [...byMarket.entries()].map(([waypoint, m]) => ({ waypoint, ...m })).sort((a, b) => b.changed - a.changed || b.reads - a.reads).slice(0, top);
  const low = buckets.filter((b) => b.changedPct !== null && b.changedPct < 10).length;
  const reading = buckets.length
    ? `${byMarket.size} market(s) read in ${buckets.length} bucket(s); ${neverChanged} never changed; ${low} bucket(s) had under 10% of reads showing a change`
    : "no reads in the window";
  return { buckets, neverChanged, marketsSeen: byMarket.size, busiest, reading };
}
