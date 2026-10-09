import type { MarketSnapshot } from "./market.js";
import { slippageCredits } from "./routeEconomics.js";

/** One line of a hold, priced. */
export interface CargoValueItem {
  symbol: string;
  units: number;
  /** Per-unit price used, or 0 when no market price is known. */
  unitPrice: number;
  /** "route": the ship's own destination; "best": best known price in its system; "none": unpriced. */
  source: "route" | "best" | "none";
  sellAt?: string;
  /** Proceeds net of our own price impact, 0 when unpriced. */
  net: number;
}

export interface CargoValue {
  /** Estimated proceeds of selling the whole hold, net of price impact. */
  value: number;
  /** The same at listed prices, no impact. */
  gross: number;
  /** Units x the per-unit cost basis the ledger holds for them (0 when unknown). */
  cost: number;
  /** Units with no known price (not in `value`). */
  unpricedUnits: number;
  items: CargoValueItem[];
}

export interface CargoValueInput {
  cargo: readonly { symbol: string; units: number }[];
  /** The ship's trader assignment, if any: its good and sell market are the best guess for where a load goes. */
  assignment?: { good: string; sellAt?: string; sellPrice?: number };
  /** The recorded market at a waypoint. */
  marketAt: (waypoint: string) => MarketSnapshot | undefined;
  /** Every recorded market in the ship's current system. */
  marketsHere: readonly MarketSnapshot[];
  /** Per-unit cost basis by good, from the cargo manifest. */
  costPerUnit?: ReadonlyMap<string, number>;
}

/**
 * Approximate value of what a ship is carrying. Each good is priced at the ship's own sell market when its route
 * is for that good (live snapshot, falling back to the route's quoted price), otherwise at the best price any market
 * in its system pays. The result is net of our own price impact (the same per-lot slippage the dispatcher charges),
 * so it reads as "about what this hold would fetch", not the list price.
 */
export function cargoValue(input: CargoValueInput): CargoValue {
  const items: CargoValueItem[] = [];
  let value = 0;
  let gross = 0;
  let cost = 0;
  let unpricedUnits = 0;

  for (const c of input.cargo) {
    if (c.units <= 0) continue;
    let unitPrice = 0;
    let tradeVolume = 0;
    let source: CargoValueItem["source"] = "none";
    let sellAt: string | undefined;

    const a = input.assignment;
    if (a && a.good === c.symbol && a.sellAt) {
      const live = input.marketAt(a.sellAt)?.tradeGoods[c.symbol];
      const price = live && live.sellPrice > 0 ? live.sellPrice : (a.sellPrice ?? 0);
      if (price > 0) {
        unitPrice = price;
        tradeVolume = live?.tradeVolume ?? 0;
        source = "route";
        sellAt = a.sellAt;
      }
    }
    if (source === "none") {
      for (const m of input.marketsHere) {
        const g = m.tradeGoods[c.symbol];
        if (g && g.sellPrice > unitPrice) {
          unitPrice = g.sellPrice;
          tradeVolume = g.tradeVolume;
          sellAt = m.symbol;
          source = "best";
        }
      }
    }

    const listed = unitPrice * c.units;
    const net = source === "none" ? 0 : Math.max(0, listed - slippageCredits(c.units, tradeVolume || c.units, unitPrice));
    if (source === "none") unpricedUnits += c.units;
    value += net;
    gross += listed;
    cost += (input.costPerUnit?.get(c.symbol) ?? 0) * c.units;
    items.push({ symbol: c.symbol, units: c.units, unitPrice, source, sellAt, net: Math.round(net) });
  }

  return { value: Math.round(value), gross: Math.round(gross), cost: Math.round(cost), unpricedUnits, items };
}

/**
 * A cheap fingerprint of every hold ("SHIP:GOOD=units,..." per ship, sorted). The dashboard caches hold values for a
 * few seconds, but a trade changes the fingerprint at once, so the cache is dropped the moment cargo moves instead
 * of showing last trade's holds beside this trade's credits.
 */
export function cargoSignature(ships: readonly { symbol: string; cargo?: { inventory?: readonly { symbol: string; units: number }[] } }[]): string {
  return ships
    .filter((s) => (s.cargo?.inventory?.length ?? 0) > 0)
    .map((s) => `${s.symbol}:${[...(s.cargo!.inventory ?? [])].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((i) => `${i.symbol}=${i.units}`).join(",")}`)
    .sort()
    .join("|");
}
