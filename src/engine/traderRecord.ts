/**
 * Whether a trader should spend an API call recording a market it just docked at. A keeper that stands at the market already
 * reads it every 5 to 60 minutes, so a snapshot that is recent enough makes the trader's own read a duplicate.
 * Pure: the caller supplies the facts. `skipWithinMs` 0 (clause off) always records, which is the behaviour before this existed.
 */
export interface TraderRecordFacts {
  /** A live keeper stands at this market. */
  keeperCovered: boolean;
  /** Age of the snapshot we hold, ms; undefined when there is none. */
  snapshotAgeMs: number | undefined;
  /** Doctrine: skip when a keeper covers the market and the snapshot is younger than this. 0 = never skip. */
  skipWithinMs: number;
}

export function traderShouldRecord(f: TraderRecordFacts): { record: boolean; reason: string } {
  if (f.skipWithinMs <= 0) return { record: true, reason: "skipping is off" };
  if (!f.keeperCovered) return { record: true, reason: "no keeper covers this market" };
  if (f.snapshotAgeMs === undefined || !Number.isFinite(f.snapshotAgeMs)) return { record: true, reason: "no snapshot held" };
  if (f.snapshotAgeMs >= f.skipWithinMs) return { record: true, reason: "the keeper's snapshot is older than the window" };
  return { record: false, reason: `a keeper covers it and its snapshot is ${Math.round(f.snapshotAgeMs / 1000)}s old` };
}
