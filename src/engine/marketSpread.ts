// How widely the fleet is spread across markets: how many different markets (and good-at-market pairs) our ships are
// buying from and selling to at the same time. Pure: ledger rows and the traders' in-flight legs come in, numbers go out.
//
// Why it matters: a market's price moves ~4-5% per tradeVolume lot we trade into it (CLAUDE.md, market dynamics), so
// profit per unit falls when many ships crowd a few markets. A wide spread means fresh prices; a narrow one means the
// same markets are being hammered. Read next to profit per hour and keeper coverage.

import type { LedgerRow } from "./metrics.js";

export interface SpreadLeg {
  shipSymbol: string;
  good: string;
  buyAt: string;
  sellAt: string;
  units: number;
}

export interface SpreadBucket {
  /** Bucket start, ISO. */
  from: string;
  /** Ships that bought or sold in the bucket. */
  ships: number;
  buyMarkets: number;
  sellMarkets: number;
  /** Markets we either bought from or sold to. */
  markets: number;
  /** Distinct (good, market) pairs traded, buys and sells counted apart. */
  goodMarketPairs: number;
  /** Distinct goods traded. */
  goods: number;
  sells: number;
  sellValue: number;
  /** Share of the bucket's sell value that went to its five biggest markets (1 = all in five markets). */
  top5SellShare: number;
}

export interface SpreadNow {
  /** Traders with a loaded or planned leg. */
  ships: number;
  buyMarkets: number;
  sellMarkets: number;
  markets: number;
  goodMarketPairs: number;
  /** Most ships heading to one market, and which. */
  busiestMarket?: { waypoint: string; ships: number };
  /** Ships per market across the markets in use; near 1 is well spread. */
  shipsPerMarket: number;
}

export interface MarketSpread {
  now: SpreadNow;
  bucketMin: number;
  buckets: SpreadBucket[];
  note: string;
}

export interface SpreadOptions {
  nowMs: number;
  sinceMs: number;
  bucketMin?: number;
}

function share(values: number[], top: number): number {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  return Math.round((sorted.slice(0, top).reduce((s, v) => s + v, 0) / total) * 1000) / 1000;
}

export function marketSpread(rows: LedgerRow[], legs: SpreadLeg[], opts: SpreadOptions): MarketSpread {
  const bucketMin = Math.max(1, opts.bucketMin ?? 15);
  const size = bucketMin * 60_000;
  const byBucket = new Map<number, LedgerRow[]>();
  for (const r of rows) {
    if (r.ts < opts.sinceMs || r.ts > opts.nowMs) continue;
    if ((r.type !== "PURCHASE" && r.type !== "SELL") || !r.good) continue;
    const key = Math.floor(r.ts / size) * size;
    const list = byBucket.get(key);
    if (list) list.push(r);
    else byBucket.set(key, [r]);
  }
  const buckets: SpreadBucket[] = [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, list]) => {
      const buy = new Set<string>();
      const sell = new Set<string>();
      const pairs = new Set<string>();
      const goods = new Set<string>();
      const ships = new Set<string>();
      const sellByMarket = new Map<string, number>();
      let sells = 0;
      let sellValue = 0;
      for (const r of list) {
        ships.add(r.ship);
        goods.add(r.good as string);
        pairs.add(`${r.type}:${r.good}@${r.waypoint}`);
        if (r.type === "PURCHASE") buy.add(r.waypoint);
        else {
          sell.add(r.waypoint);
          sells += 1;
          sellValue += r.total;
          sellByMarket.set(r.waypoint, (sellByMarket.get(r.waypoint) ?? 0) + r.total);
        }
      }
      return {
        from: new Date(start).toISOString(),
        ships: ships.size,
        buyMarkets: buy.size,
        sellMarkets: sell.size,
        markets: new Set([...buy, ...sell]).size,
        goodMarketPairs: pairs.size,
        goods: goods.size,
        sells,
        sellValue: Math.round(sellValue),
        top5SellShare: share([...sellByMarket.values()], 5),
      };
    });

  const buyNow = new Set(legs.map((l) => l.buyAt));
  const sellNow = new Set(legs.map((l) => l.sellAt));
  const all = new Set([...buyNow, ...sellNow]);
  const perMarket = new Map<string, Set<string>>();
  for (const l of legs) {
    for (const w of new Set([l.buyAt, l.sellAt])) {
      const s = perMarket.get(w) ?? new Set<string>();
      s.add(l.shipSymbol);
      perMarket.set(w, s);
    }
  }
  let busiest: { waypoint: string; ships: number } | undefined;
  for (const [waypoint, set] of perMarket) if (!busiest || set.size > busiest.ships) busiest = { waypoint, ships: set.size };
  const ships = new Set(legs.map((l) => l.shipSymbol)).size;
  const now: SpreadNow = {
    ships,
    buyMarkets: buyNow.size,
    sellMarkets: sellNow.size,
    markets: all.size,
    goodMarketPairs: new Set(legs.flatMap((l) => [`buy:${l.good}@${l.buyAt}`, `sell:${l.good}@${l.sellAt}`])).size,
    busiestMarket: busiest,
    shipsPerMarket: all.size > 0 ? Math.round((ships / all.size) * 100) / 100 : 0,
  };
  return {
    now,
    bucketMin,
    buckets,
    note: "now = trips in flight (loaded legs only). buckets = ledger buys and sells inside each window; a market counts once however many times it was used. top5SellShare near 1 means sales are crowded into few markets.",
  };
}
