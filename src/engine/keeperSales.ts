/**
 * Keepers by what we trade at their markets: the stationed keepers whose market has seen none of our sales (and none of
 * our buys) this week are paid-for price listening that no route of ours uses.
 *
 * Pure: the caller passes the stationed keepers and the ledger's trade totals per waypoint (already limited to the
 * current week by the tenant's universe scope).
 */

export interface WaypointTrade { waypoint: string; sells: number; sellUnits: number; sellValue: number; buys: number; buyUnits: number; buyValue: number }
export interface StationedKeeper { ship: string; market: string; score?: number; goods?: number }

export interface KeeperSalesRow {
  ship: string;
  market: string;
  score: number | null;
  goods: number | null;
  sells: number;
  sellValue: number;
  buys: number;
  buyValue: number;
}

export interface KeeperSalesReport {
  keepers: number;
  noSales: number;
  noTrade: number;
  /** Zero sales first (and zero buys before some), then by market score, lowest first. */
  rows: KeeperSalesRow[];
}

export function keeperSales(keepers: readonly StationedKeeper[], trades: readonly WaypointTrade[], onlyNoSales = true): KeeperSalesReport {
  const by = new Map(trades.map((t) => [t.waypoint, t]));
  const rows: KeeperSalesRow[] = keepers.map((k) => {
    const t = by.get(k.market);
    return {
      ship: k.ship, market: k.market, score: k.score ?? null, goods: k.goods ?? null,
      sells: t?.sells ?? 0, sellValue: Math.round(t?.sellValue ?? 0), buys: t?.buys ?? 0, buyValue: Math.round(t?.buyValue ?? 0),
    };
  });
  rows.sort((a, b) => a.sells - b.sells || a.buys - b.buys || (a.score ?? -1) - (b.score ?? -1) || a.market.localeCompare(b.market));
  const noSales = rows.filter((r) => r.sells === 0);
  return {
    keepers: rows.length,
    noSales: noSales.length,
    noTrade: rows.filter((r) => r.sells === 0 && r.buys === 0).length,
    rows: onlyNoSales ? noSales : rows,
  };
}
