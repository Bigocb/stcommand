/**
 * Where keepers are worth sending, from what the markets of a surveyed system trade, before any ship has stood there.
 *
 * The game gives anyone each market's import, export and exchange lists (no prices; those need a ship present). The number of
 * distinct goods is the signal the keeper recommendation already uses (keeperBuy.ts `distinctGoods`, doctrine
 * keeperMinGoodsRecommended). This ranks a system's markets by it and flags the ones that already have a keeper. Read-only and pure.
 */
export interface DirectoryRow {
  waypointSymbol: string;
  systemSymbol: string;
  imports: readonly string[];
  exports: readonly string[];
  exchange: readonly string[];
  updatedAt: string;
}

export interface DirectoryMarket {
  market: string;
  goods: number;
  imports: number;
  exports: number;
  exchange: number;
  covered: boolean;
  ageHours: number | null;
}

export interface DirectorySystem {
  system: string;
  markets: number;
  coveredMarkets: number;
  /** Markets with at least `minGoods` goods that have no keeper. */
  worthKeeping: number;
  ranked: DirectoryMarket[];
}

export function summarizeDirectory(rows: readonly DirectoryRow[], coveredMarkets: ReadonlySet<string>, nowMs: number, minGoods = 5): DirectorySystem[] {
  const bySystem = new Map<string, DirectoryMarket[]>();
  for (const r of rows) {
    const goods = new Set([...r.imports, ...r.exports, ...r.exchange]).size;
    const list = bySystem.get(r.systemSymbol) ?? [];
    list.push({
      market: r.waypointSymbol, goods, imports: r.imports.length, exports: r.exports.length, exchange: r.exchange.length,
      covered: coveredMarkets.has(r.waypointSymbol),
      ageHours: r.updatedAt ? Math.round(((nowMs - Date.parse(r.updatedAt)) / 3_600_000) * 10) / 10 : null,
    });
    bySystem.set(r.systemSymbol, list);
  }
  return [...bySystem.entries()]
    .map(([system, list]) => {
      const ranked = [...list].sort((a, b) => b.goods - a.goods || a.market.localeCompare(b.market));
      return { system, markets: ranked.length, coveredMarkets: ranked.filter((m) => m.covered).length, worthKeeping: ranked.filter((m) => !m.covered && m.goods >= minGoods).length, ranked };
    })
    .sort((a, b) => b.worthKeeping - a.worthKeeping || a.system.localeCompare(b.system));
}

export interface StaleMarket {
  system: string;
  market: string;
  goods: number;
  /** Minutes since the newest price we hold for it; null = never priced. */
  ageMin: number | null;
}

/**
 * Markets in the given systems with at least `minGoods` goods, no keeper stationed on them, and a newest price older than
 * `olderThanMin` minutes (or none at all), oldest first. The operator's watch (2026-11-25): "uncovered markets with 5 or more
 * products with prices older than 55 min". Goods come from the survey directory; ages from the newest snapshot per market. Pure.
 */
export function staleUncoveredMarkets(
  rows: readonly DirectoryRow[],
  newestByMarket: ReadonlyMap<string, number>,
  keeperMarkets: ReadonlySet<string>,
  systems: ReadonlySet<string>,
  nowMs: number,
  opts: { minGoods: number; olderThanMin: number },
): StaleMarket[] {
  const out: StaleMarket[] = [];
  for (const r of rows) {
    if (!systems.has(r.systemSymbol) || keeperMarkets.has(r.waypointSymbol)) continue;
    const goods = new Set([...r.imports, ...r.exports, ...r.exchange]).size;
    if (goods < opts.minGoods) continue;
    const t = newestByMarket.get(r.waypointSymbol);
    const ageMin = t === undefined ? null : Math.round((nowMs - t) / 60_000);
    if (ageMin !== null && ageMin <= opts.olderThanMin) continue;
    out.push({ system: r.systemSymbol, market: r.waypointSymbol, goods, ageMin });
  }
  return out.sort((a, b) => (b.ageMin ?? Infinity) - (a.ageMin ?? Infinity) || b.goods - a.goods || a.market.localeCompare(b.market));
}
