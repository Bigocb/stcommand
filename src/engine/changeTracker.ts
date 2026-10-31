/**
 * Remembers what was last written for each key, so a per-tick mirror writes only what changed.
 *
 * Three coordinator steps (ship claims, ship states, cargo manifests) wrote every ship's row to the database on every pass, one
 * transaction per row: 544 ships took about 3.5 s of every core pass (2026-10-31). Each now collects its rows, asks this which differ from
 * the last write, and sends those in one batch. A write that fails is not marked saved, so the next pass sends it again.
 *
 * Pure: values are compared by their JSON, nothing else is touched.
 */
export class ChangeTracker<V> {
  private saved = new Map<string, string>();

  /** The entries whose value differs from what was last marked saved (or that were never saved), in the order given. */
  changed<T extends V>(entries: Iterable<readonly [string, T]>): [string, T][] {
    const out: [string, T][] = [];
    for (const [key, value] of entries) if (this.saved.get(key) !== JSON.stringify(value)) out.push([key, value]);
    return out;
  }

  /** Record these as written. Call it only after the write succeeded. */
  markSaved(entries: Iterable<readonly [string, V]>): void {
    for (const [key, value] of entries) this.saved.set(key, JSON.stringify(value));
  }

  /** Forget everything, so the next pass writes every row again (a new connection, a restored backup). */
  reset(): void {
    this.saved.clear();
  }
}

/** Split `items` into batches of at most `size`: one statement per batch keeps a single query's parameter count bounded. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
