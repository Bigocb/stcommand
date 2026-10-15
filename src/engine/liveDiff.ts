/**
 * A keyed diff for the live feed: which rows changed since the last send, and which are gone. Rows are compared as
 * JSON; `compareAs` decides what counts as a change (for instance leaving out a countdown that ticks by itself).
 *
 * Pure.
 */
export interface KeyedDiff<T> {
  changed: T[];
  removed: string[];
}

export function diffKeyed<T>(
  last: ReadonlyMap<string, string>,
  rows: readonly T[],
  keyOf: (row: T) => string,
  compareAs: (row: T) => unknown = (row) => row,
): { diff: KeyedDiff<T>; next: Map<string, string> } {
  const next = new Map<string, string>();
  const changed: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const json = JSON.stringify(compareAs(row));
    next.set(key, json);
    if (last.get(key) !== json) changed.push(row);
  }
  const removed = [...last.keys()].filter((k) => !next.has(k));
  return { diff: { changed, removed }, next };
}

/** True when a diff has nothing to send. */
export const emptyDiff = (d: KeyedDiff<unknown>): boolean => d.changed.length === 0 && d.removed.length === 0;
