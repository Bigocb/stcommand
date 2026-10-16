// priceBook: fold raw Grand Exchange orders + sale history into one row per item. Pure (no clock: pass `now`).

export interface GeOrder { type: 'buy' | 'sell'; code: string; quantity: number; price: number; [k: string]: unknown }
export interface GeSale { code?: string; quantity: number; price: number; sold_at: string; [k: string]: unknown }
export type GeHistory = Record<string, readonly GeSale[]>;

export interface PriceEntry {
  code: string;
  /** Highest open BUY order: what you receive selling instantly to the GE. null = no buy orders. */
  bestBuy: number | null;
  /** Lowest open SELL order: what you pay buying instantly from the GE. null = no sell orders. */
  bestSell: number | null;
  /** bestSell - bestBuy; null unless both sides exist. */
  spread: number | null;
  /** Open order counts and total units on each side. */
  depth: { buyOrders: number; buyQty: number; sellOrders: number; sellQty: number };
  /** Volume-weighted mean sale price over the 7 days before `now`; null with no sales in window. */
  avg7d: number | null;
  /** Units sold in that window. */
  volume7d: number;
}
export type PriceBook = Record<string, PriceEntry>;

const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface PriceBookOptions {
  /** Window end in ms since epoch. Default: the newest sale in `history` (0 when there is none). */
  now?: number;
}

export function priceBook(orders: readonly GeOrder[], history: GeHistory = {}, opts: PriceBookOptions = {}): PriceBook {
  const book: PriceBook = {};
  const row = (code: string): PriceEntry =>
    (book[code] ??= { code, bestBuy: null, bestSell: null, spread: null, depth: { buyOrders: 0, buyQty: 0, sellOrders: 0, sellQty: 0 }, avg7d: null, volume7d: 0 });
  for (const o of orders) {
    const e = row(o.code);
    if (o.type === 'buy') {
      e.bestBuy = e.bestBuy === null ? o.price : Math.max(e.bestBuy, o.price);
      e.depth.buyOrders++; e.depth.buyQty += o.quantity;
    } else {
      e.bestSell = e.bestSell === null ? o.price : Math.min(e.bestSell, o.price);
      e.depth.sellOrders++; e.depth.sellQty += o.quantity;
    }
  }
  let now = opts.now;
  if (now === undefined) {
    now = 0;
    for (const sales of Object.values(history)) for (const s of sales) { const t = Date.parse(s.sold_at); if (t > now) now = t; }
  }
  for (const [code, sales] of Object.entries(history)) {
    let units = 0, value = 0;
    for (const s of sales) {
      const t = Date.parse(s.sold_at);
      if (!(t <= now && t > now - WEEK_MS)) continue;
      units += s.quantity; value += s.quantity * s.price;
    }
    const e = row(code);
    e.volume7d = units;
    e.avg7d = units > 0 ? value / units : null;
  }
  for (const e of Object.values(book)) e.spread = e.bestBuy !== null && e.bestSell !== null ? e.bestSell - e.bestBuy : null;
  return book;
}
