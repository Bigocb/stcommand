/**
 * How much a keeper at a market is worth, and how many keepers the fleet can afford.
 *
 * A keeper costs a probe (about 29k) once and then one market read every 5 to 30 minutes for as long as it lives. The reads
 * are what limits the fleet: the API allows 90 calls a minute and on 2026-10-22 the fleet was already using all of them, so
 * every new keeper must earn its poll. The survey already lists what each market imports, exports and exchanges, with no ship
 * there and before any keeper exists, so a market can be scored on what it trades before anything is bought for it.
 *
 * Score: for each good the market trades, a weight for its role times its typical price in thousands of credits (capped, so one
 * very dear good does not decide it), with goods we have a profitable route for counting half again. An export is where a trader
 * buys and so counts most; an import is where it sells; an exchange is both and trades thinly.
 *
 * Pure: no I/O, no clock. Policy is data (a limit of 0 switches a limit off).
 */

export interface MarketGoods {
  imports?: readonly string[];
  exports?: readonly string[];
  exchange?: readonly string[];
}

export interface ScoreContext {
  /** Typical unit price of a good across the markets we know; undefined = not known. */
  priceOf: (good: string) => number | undefined;
  /** Used when a good has no known price. */
  defaultPrice: number;
  /** Goods that have a profitable route right now. */
  routeGoods?: ReadonlySet<string>;
}

export const ROLE_WEIGHT = { export: 1, import: 0.8, exchange: 0.4 } as const;
export const PRICE_CAP = 20_000;
export const ROUTE_BONUS = 1.5;

export interface MarketScore { score: number; goods: number; top: string[] }

export function marketKeeperScore(m: MarketGoods, ctx: ScoreContext): MarketScore {
  // A good listed under two roles counts once, at its strongest.
  const role = new Map<string, number>();
  const put = (g: string, w: number) => role.set(g, Math.max(role.get(g) ?? 0, w));
  for (const g of m.exports ?? []) put(g, ROLE_WEIGHT.export);
  for (const g of m.imports ?? []) put(g, ROLE_WEIGHT.import);
  for (const g of m.exchange ?? []) put(g, ROLE_WEIGHT.exchange);
  const parts = [...role].map(([g, w]) => {
    const price = Math.min(ctx.priceOf(g) ?? ctx.defaultPrice, PRICE_CAP);
    return { good: g, value: w * (price / 1000) * (ctx.routeGoods?.has(g) ? ROUTE_BONUS : 1) };
  }).sort((a, b) => b.value - a.value);
  const score = Math.round(parts.reduce((t, p) => t + p.value, 0) * 10) / 10;
  return { score, goods: role.size, top: parts.slice(0, 3).map((p) => p.good) };
}

/** The goods lists of one market from stored price rows, whose `type` says export, import or exchange. */
export function goodsFromRows(rows: readonly { goodSymbol: string; type: string }[]): MarketGoods {
  const pick = (t: string) => rows.filter((r) => r.type.toUpperCase() === t).map((r) => r.goodSymbol);
  return { exports: pick("EXPORT"), imports: pick("IMPORT"), exchange: pick("EXCHANGE") };
}

/** Median of a list, for the typical price of a good; undefined when empty. */
export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Whether another keeper may be bought. `max` of 0 (the clause off) means no limit. Stationed and on the way both count: a probe
 * already bought will poll as soon as it arrives.
 */
export function keeperBudget(i: { keepers: number; max: number }): { allow: boolean; reason: string } {
  if (i.max <= 0) return { allow: true, reason: "no keeper limit" };
  if (i.keepers >= i.max) return { allow: false, reason: `${i.keepers} keepers, at the limit of ${i.max}` };
  return { allow: true, reason: `${i.keepers} of ${i.max} keepers` };
}

/** Order uncovered markets for buying: operator-listed ones with no score first (the operator put them there), then best score first. */
export function orderForBuying(markets: readonly string[], scoreOf: (market: string) => number | undefined): string[] {
  const idx = new Map(markets.map((m, i) => [m, i]));
  return [...markets].sort((a, b) => {
    const sa = scoreOf(a), sb = scoreOf(b);
    if (sa === undefined && sb === undefined) return idx.get(a)! - idx.get(b)!;
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    return sb - sa || idx.get(a)! - idx.get(b)!;
  });
}

export interface KeeperReview {
  asOf: string;
  budget: { keepers: number; max: number; room: number | null; callsPerMinNow: number; callsPerMinAtMax: number | null; apiBudgetPerMin: number };
  /** Lowest-value stationed keepers first. `score` undefined = no goods known for that market. */
  weakest: { ship: string; market: string; score?: number; goods?: number; pollMin: number }[];
  /** Uncovered markets in the order they would be bought. */
  next: { market: string; score?: number; goods?: number; top?: string[] }[];
  /** An uncovered market clearly better than a stationed keeper: swapping would improve coverage at the same polling cost. */
  swaps: { scrapShip: string; scrapMarket: string; scrapScore: number; instead: string; insteadScore: number }[];
}

export function buildKeeperReview(i: {
  nowIso: string;
  stationed: { ship: string; market: string; score?: number; goods?: number; pollMs: number }[];
  uncovered: { market: string; score?: number; goods?: number; top?: string[] }[];
  max: number;
  apiBudgetPerMin?: number;
  listLimit?: number;
  /** How much better an uncovered market must score than a keeper's before a swap is suggested. */
  swapMargin?: number;
}): KeeperReview {
  const limit = i.listLimit ?? 15;
  const margin = i.swapMargin ?? 1.5;
  const callsPerMin = (ms: number) => 60_000 / Math.max(ms, 60_000);
  const now = i.stationed.reduce((t, k) => t + callsPerMin(k.pollMs), 0);
  const avg = i.stationed.length ? now / i.stationed.length : 0;
  const scored = i.stationed.filter((k) => k.score !== undefined).sort((a, b) => a.score! - b.score!);
  const nextScored = i.uncovered.filter((u) => u.score !== undefined).sort((a, b) => b.score! - a.score!);
  const swaps: KeeperReview["swaps"] = [];
  const used = new Set<string>();
  for (const u of nextScored) {
    const weak = scored.find((k) => !used.has(k.ship) && k.score! * margin < u.score!);
    if (!weak) break;
    used.add(weak.ship);
    swaps.push({ scrapShip: weak.ship, scrapMarket: weak.market, scrapScore: weak.score!, instead: u.market, insteadScore: u.score! });
    if (swaps.length >= limit) break;
  }
  return {
    asOf: i.nowIso,
    budget: {
      keepers: i.stationed.length,
      max: i.max,
      room: i.max > 0 ? Math.max(0, i.max - i.stationed.length) : null,
      callsPerMinNow: Math.round(now * 10) / 10,
      callsPerMinAtMax: i.max > 0 ? Math.round(avg * i.max * 10) / 10 : null,
      apiBudgetPerMin: i.apiBudgetPerMin ?? 90,
    },
    weakest: scored.slice(0, limit).map((k) => ({ ship: k.ship, market: k.market, score: k.score, goods: k.goods, pollMin: Math.round(k.pollMs / 60_000) })),
    next: [...i.uncovered].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, limit),
    swaps,
  };
}
