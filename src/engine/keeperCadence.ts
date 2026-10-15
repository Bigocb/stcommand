/** Keeper poll spacing: a third of the time the market has sat unchanged, between 5 and 30 minutes. */
export const KEEPER_POLL_MIN_MS = 5 * 60_000;
export const KEEPER_POLL_MAX_MS = 30 * 60_000;

export function keeperPollDelayMs(idleMs: number): number {
  return Math.min(KEEPER_POLL_MAX_MS, Math.max(KEEPER_POLL_MIN_MS, Math.round(idleMs / 3)));
}

/** A market's price and supply signature, independent of the order the goods are listed in. */
export function marketSignature(goods: readonly { symbol: string; purchasePrice: number; sellPrice: number; supply?: string }[]): string {
  return goods
    .map((g) => `${g.symbol}:${g.purchasePrice}:${g.sellPrice}:${g.supply ?? ""}`)
    .sort()
    .join("|");
}

/** One stored snapshot row, as the seed reads it. */
export interface SnapshotRow {
  waypoint: string;
  good: string;
  ts: number;
  purchasePrice: number;
  sellPrice: number;
  supply: string;
}

/**
 * Where each market's cadence stood before a restart, from its stored snapshots: the signature of its latest prices and
 * when they last differed from the snapshot before. A market with no change in the rows given counts as unchanged since
 * its earliest row. The cadence used to start from nothing on every deploy, so every keeper polled at the 5-minute floor
 * for up to an hour and a half after it.
 */
export function cadenceSeeds(rows: readonly SnapshotRow[]): Map<string, { sig: string; changedAt: number }> {
  const byKey = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const k = `${r.waypoint}\u0000${r.good}`;
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const markets = new Map<string, { latest: SnapshotRow[]; changedAt: number; earliest: number }>();
  for (const list of byKey.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let changed = -Infinity;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.purchasePrice !== b.purchasePrice || a.sellPrice !== b.sellPrice || a.supply !== b.supply) changed = b.ts;
    }
    const wp = list[0]!.waypoint;
    const m = markets.get(wp) ?? { latest: [], changedAt: -Infinity, earliest: Infinity };
    m.latest.push(list[list.length - 1]!);
    m.changedAt = Math.max(m.changedAt, changed);
    m.earliest = Math.min(m.earliest, list[0]!.ts);
    markets.set(wp, m);
  }
  const out = new Map<string, { sig: string; changedAt: number }>();
  for (const [wp, m] of markets) {
    const sig = marketSignature(m.latest.map((r) => ({ symbol: r.good, purchasePrice: r.purchasePrice, sellPrice: r.sellPrice, supply: r.supply })));
    out.set(wp, { sig, changedAt: Number.isFinite(m.changedAt) ? m.changedAt : m.earliest });
  }
  return out;
}
