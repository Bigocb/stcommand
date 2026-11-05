/**
 * Trading pace split into what the traders earn and what expansion costs.
 *
 * Tower's headline "profit per hour" was every sale's realized profit minus every refuel and jump the fleet paid. That mixes
 * two things the operator reads differently. 2026-11-05 23:33: the headline read -15,437 an hour while trading itself made
 * about +1.17M, because 79 of the hour's 158 jumps (about 490k) were 26 keeper probes being delivered to three staged systems
 * and three explorers touring, and 500k went on two big sales into thin markets.
 *
 * The split: a refuel or jump paid by a ship that is not a trader (keeper, tour, explorer, scout, surveyor, ...) is expansion
 * and upkeep, kept out of the trading figure and reported on its own. A trader's own fuel and jumps stay in trading, as do
 * realized losses: those are trading results. Nothing is hidden: trading plus expansion is the old headline.
 *
 * Pure: ledger rows and the set of expansion ships in, two equal-width bucket arrays out (oldest first, the last ending
 * now), each in the shape paceFromBuckets() takes. Expansion values are costs, so negative.
 */

export interface PaceRow {
  timestampMs: number;
  type: "SELL" | "REFUEL" | "JUMP";
  shipSymbol: string;
  /** Realized profit on a SELL row; null when no cost basis was tracked. */
  realizedPnl: number | null;
  /** Credits the row cost (REFUEL and JUMP). */
  total: number;
}

export interface SplitBuckets {
  trading: number[];
  expansion: number[];
}

export function splitPaceBuckets(rows: readonly PaceRow[], startMs: number, bucketMs: number, count: number, expansionShips: ReadonlySet<string>): SplitBuckets {
  const trading = Array<number>(count).fill(0);
  const expansion = Array<number>(count).fill(0);
  for (const r of rows) {
    const idx = Math.min(count - 1, Math.floor((r.timestampMs - startMs) / bucketMs));
    if (idx < 0) continue;
    if (r.type === "SELL") {
      trading[idx] = (trading[idx] ?? 0) + (r.realizedPnl ?? 0);
    } else if (expansionShips.has(r.shipSymbol)) {
      expansion[idx] = (expansion[idx] ?? 0) - r.total;
    } else {
      trading[idx] = (trading[idx] ?? 0) - r.total;
    }
  }
  return { trading: trading.map(Math.round), expansion: expansion.map(Math.round) };
}

/** The ships whose fuel and jumps count as expansion: everything the fleet is running that is not a trader. */
export function expansionShipsOf(roles: readonly { symbol: string; role: string }[]): Set<string> {
  return new Set(roles.filter((r) => r.role !== "trader").map((r) => r.symbol));
}
