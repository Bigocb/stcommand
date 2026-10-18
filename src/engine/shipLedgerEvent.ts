/**
 * The timeline event a SHIP ledger row stands for. A ship purchase and a scrap are both SHIP rows with a positive total (the credits paid, the credits received), and
 * the scrap's trade symbol is "SCRAP"; the timeline used to call every one of them "bought", so the reset wind-down (26 ships scrapped on 2026-10-18, 11:03 to 12:59)
 * read as 26 purchases of ships called SCRAP. A repair is the same type with a negative total and is not an event.
 * Pure: a ledger row in, an event (or null) out.
 */
export interface ShipLedgerRow { shipSymbol: string; waypointSymbol: string; type: string; tradeSymbol?: string | null; total: number }
export interface ShipLedgerEvent { kind: "ship_purchased" | "ship_scrapped"; detail: string; meta: Record<string, unknown> }

export function shipLedgerEvent(e: ShipLedgerRow): ShipLedgerEvent | null {
  if (e.type !== "SHIP" || !(e.total > 0)) return null;
  const price = Math.round(e.total);
  if (e.tradeSymbol === "SCRAP") return { kind: "ship_scrapped", detail: `scrapped ${e.shipSymbol} at ${e.waypointSymbol} for ${price}c`, meta: { yard: e.waypointSymbol, proceeds: price } };
  return { kind: "ship_purchased", detail: `bought ${e.shipSymbol} (${e.tradeSymbol ?? "?"}) at ${e.waypointSymbol} for ${price}c`, meta: { shipType: e.tradeSymbol ?? null, yard: e.waypointSymbol, price } };
}
