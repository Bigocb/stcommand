/**
 * How much of a trader's time it spends carrying cargo, from the ledger alone (docs/backhaul-plan.md, Step 0).
 *
 * A ship is "loaded" from the first PURCHASE that takes its cargo above zero until sells bring it back to zero.
 * Everything else is "empty": flying to a buy, docking, waiting, repositioning. Ledger-only, so a ship that bought
 * long ago and is still carrying counts as loaded to the window's end, and a window that opens mid-trip assumes the
 * ship was loaded from the window start until its first sell.
 */
export interface TradeRow {
  shipSymbol: string;
  type: "PURCHASE" | "SELL";
  units: number;
  timestampMs: number;
  total: number;
  realizedPnl: number | null;
}

export interface ShipDeadhead {
  shipSymbol: string;
  loadedMs: number;
  emptyMs: number;
  /** loaded / window, 0..1. */
  loadedShare: number;
  trips: number;
  pnl: number;
  /** Realized profit per hour of loaded time, or 0 with no loaded time. */
  pnlPerLoadedHour: number;
}

export function deadheadFromTrades(rows: readonly TradeRow[], fromMs: number, toMs: number): { ships: ShipDeadhead[]; fleet: { loadedShare: number; pnl: number; pnlPerLoadedHour: number } } {
  const windowMs = Math.max(1, toMs - fromMs);
  const byShip = new Map<string, TradeRow[]>();
  for (const r of rows) {
    if (r.timestampMs < fromMs || r.timestampMs > toMs) continue;
    (byShip.get(r.shipSymbol) ?? byShip.set(r.shipSymbol, []).get(r.shipSymbol)!).push(r);
  }
  const ships: ShipDeadhead[] = [];
  for (const [shipSymbol, list] of byShip) {
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    let net = 0;
    let loadedSince: number | undefined;
    let loadedMs = 0;
    let trips = 0;
    let pnl = 0;
    // A window that opens on a SELL means the ship was already carrying: loaded from the window start.
    if (list[0]?.type === "SELL") loadedSince = fromMs;
    for (const r of list) {
      if (r.type === "PURCHASE") {
        if (net <= 0 && loadedSince === undefined) { loadedSince = r.timestampMs; trips += 1; }
        net += r.units;
      } else {
        net -= r.units;
        pnl += r.realizedPnl ?? 0;
        if (net <= 0) {
          net = 0;
          if (loadedSince !== undefined) { loadedMs += r.timestampMs - loadedSince; loadedSince = undefined; }
        }
      }
    }
    if (loadedSince !== undefined) loadedMs += toMs - loadedSince;
    loadedMs = Math.min(loadedMs, windowMs);
    ships.push({
      shipSymbol,
      loadedMs,
      emptyMs: windowMs - loadedMs,
      loadedShare: loadedMs / windowMs,
      trips,
      pnl: Math.round(pnl),
      pnlPerLoadedHour: loadedMs > 0 ? Math.round(pnl / (loadedMs / 3_600_000)) : 0,
    });
  }
  ships.sort((a, b) => b.pnl - a.pnl);
  const loaded = ships.reduce((s, x) => s + x.loadedMs, 0);
  const pnl = ships.reduce((s, x) => s + x.pnl, 0);
  return {
    ships,
    fleet: {
      loadedShare: ships.length ? loaded / (ships.length * windowMs) : 0,
      pnl,
      pnlPerLoadedHour: loaded > 0 ? Math.round(pnl / (loaded / 3_600_000)) : 0,
    },
  };
}
