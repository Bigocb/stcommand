/**
 * Write-through copy of `market_latest` in memory (issue #88 P4).
 *
 * `Store.latestMarketSnapshots()` had a 5 s memo that every market write threw away. Keepers write 340-600 times a minute, so
 * nearly every caller (16 call sites: feeds every 2 s per carrier, the route build, fuel stops, staging) re-read and re-parsed
 * the whole table (about 50,000 rows): the row parsing alone was about 10% of the process's CPU on 2026-11-27, and much of a
 * keeper task's database time. Here the table is read once, every successful write is applied to the copy, and a full reload
 * runs at most every `reloadMs` as a backstop for writes from outside this process.
 *
 * A pure cache of database rows (Postgres stays the record), so it lives in memory on purpose and is rebuilt on start. A write
 * that lands while a reload is in flight is kept and applied again on top of the reloaded rows, so the reload cannot undo it.
 */
export interface LatestRow {
  systemSymbol: string;
  waypointSymbol: string;
  goodSymbol: string;
  type: string;
  supply: string;
  purchasePrice: number;
  sellPrice: number;
  tradeVolume: number;
  timestamp: string;
}

export type LatestWrite = Omit<LatestRow, "timestamp"> & { activity?: string | null };

const keyOf = (r: { waypointSymbol: string; goodSymbol: string }) => `${r.waypointSymbol}\u0000${r.goodSymbol}`;

export class LatestMarketCache {
  private byKey = new Map<string, LatestRow>();
  private list: LatestRow[] | undefined;
  private loadedAt = 0;
  private loaded = false;
  private loading: Promise<void> | undefined;
  /** Writes applied while a reload is in flight, replayed on top of what it returns. */
  private duringLoad: LatestRow[] | undefined;

  constructor(
    private readonly load: () => Promise<LatestRow[]>,
    private readonly reloadMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every row, newest write applied. The same array is returned until the next write or reload (callers must not mutate it). */
  async all(): Promise<LatestRow[]> {
    if (!this.loaded || this.now() - this.loadedAt >= this.reloadMs) await this.reload();
    if (!this.list) this.list = [...this.byKey.values()];
    return this.list;
  }

  /** Apply rows just written to the database, stamped `at` (ISO). Before the first load there is nothing to keep current. */
  apply(rows: readonly LatestWrite[], at: string): void {
    if (!this.loaded && !this.loading) return;
    for (const r of rows) {
      const row: LatestRow = {
        systemSymbol: r.systemSymbol, waypointSymbol: r.waypointSymbol, goodSymbol: r.goodSymbol, type: r.type, supply: r.supply,
        purchasePrice: r.purchasePrice, sellPrice: r.sellPrice, tradeVolume: r.tradeVolume, timestamp: at,
      };
      this.byKey.set(keyOf(row), row);
      this.duringLoad?.push(row);
    }
    this.list = undefined;
  }

  /** Forget everything (a reset truncated the table). */
  clear(): void {
    this.byKey = new Map();
    this.list = undefined;
    this.loaded = false;
    this.loadedAt = 0;
  }

  private reload(): Promise<void> {
    if (this.loading) return this.loading;
    this.duringLoad = [];
    this.loading = (async () => {
      const rows = await this.load();
      const next = new Map<string, LatestRow>();
      for (const r of rows) next.set(keyOf(r), r);
      for (const r of this.duringLoad ?? []) next.set(keyOf(r), r);
      this.byKey = next;
      this.list = undefined;
      this.loadedAt = this.now();
      this.loaded = true;
    })().finally(() => {
      this.loading = undefined;
      this.duringLoad = undefined;
    });
    return this.loading;
  }
}
