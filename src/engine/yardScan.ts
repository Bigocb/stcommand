/**
 * Hulls on offer across every shipyard we have read, ranked by what they can move per credit.
 *
 * A ship's worth to a trader is roughly cargo x speed (units carried per unit of time), and the price to get it is the
 * cost, so `score` is cargo x speed per 1,000 credits. The yard record's own `cargoCapacity` is often 0 (the frame's
 * base hold; real hold comes from the fitted modules), so the hold is read from the cargo modules, falling back to the
 * known sizes by module name.
 *
 * Read-only and pure: rows in, a report out. It advises which hull to look at; buying stays with the operator.
 */

export interface YardRow {
  systemSymbol: string;
  waypointSymbol: string;
  shipType: string;
  shipTypeName?: string;
  purchasePrice: number;
  cargoCapacity?: number;
  fuelCapacity?: number;
  engineSpeed?: number | null;
  frameSymbol?: string;
  /** ISO time the yard was last read. */
  timestamp?: string;
  modules?: { symbol: string; capacity?: number }[] | null;
}

export interface YardPolicy {
  /** A hull counts as "fast" when its speed is above this (the common light hulls are 15). */
  fastAbove: number;
  /** ... and "affordable" when it costs at most this. */
  affordableUnder: number;
  /** Rows listed per section. */
  limit: number;
}

export const DEFAULT_YARD_POLICY: YardPolicy = { fastAbove: 15, affordableUnder: 1_000_000, limit: 15 };

export interface HullOffer {
  shipType: string;
  name: string;
  frame?: string;
  cargo: number;
  speed: number;
  fuel: number;
  price: number;
  yard: string;
  system: string;
  yardsOffering: number;
  ageHours: number | null;
  /** Cargo x speed per 1,000 credits at the cheapest yard. */
  score: number;
}

export interface YardReport {
  hulls: number;
  yardsRead: number;
  /** Cheapest offer per hull type, best score first. */
  ranked: HullOffer[];
  /** Hulls above `fastAbove` speed at or under `affordableUnder`, best score first: the answer to "any cheap fast ship?". */
  fastAndAffordable: HullOffer[];
  /** Hulls with hold x speed per hull better than the best light hauler's, regardless of price. */
  note: string;
}

/** Hold sizes of the cargo modules by symbol, for yard rows whose module list carries no capacity. */
const HOLD_BY_SYMBOL: Record<string, number> = {
  MODULE_CARGO_HOLD_I: 30,
  MODULE_CARGO_HOLD_II: 40,
  MODULE_CARGO_HOLD_III: 75,
};

/** What the hull carries: the largest of its recorded hold and the sum of its cargo modules. */
export function holdOf(row: YardRow): number {
  const fromModules = (row.modules ?? []).reduce((n, m) => {
    if (!m.symbol.startsWith("MODULE_CARGO_HOLD")) return n;
    return n + (m.capacity && m.capacity > 0 ? m.capacity : (HOLD_BY_SYMBOL[m.symbol] ?? 0));
  }, 0);
  return Math.max(row.cargoCapacity ?? 0, fromModules);
}

export function scoreOf(cargo: number, speed: number, price: number): number {
  return price > 0 ? Math.round(((cargo * speed) / price) * 1000 * 10) / 10 : 0;
}

export function yardReport(rows: readonly YardRow[], nowMs: number, policy: YardPolicy = DEFAULT_YARD_POLICY): YardReport {
  const byType = new Map<string, { best: YardRow; yards: Set<string> }>();
  for (const r of rows) {
    if (!(r.purchasePrice > 0) || !(r.engineSpeed && r.engineSpeed > 0)) continue;
    const cur = byType.get(r.shipType);
    if (!cur) byType.set(r.shipType, { best: r, yards: new Set([r.waypointSymbol]) });
    else {
      cur.yards.add(r.waypointSymbol);
      if (r.purchasePrice < cur.best.purchasePrice) cur.best = r;
    }
  }
  const offers: HullOffer[] = [...byType.values()].map(({ best, yards }) => {
    const cargo = holdOf(best);
    const speed = best.engineSpeed ?? 0;
    return {
      shipType: best.shipType,
      name: best.shipTypeName ?? best.shipType,
      frame: best.frameSymbol,
      cargo,
      speed,
      fuel: best.fuelCapacity ?? 0,
      price: best.purchasePrice,
      yard: best.waypointSymbol,
      system: best.systemSymbol,
      yardsOffering: yards.size,
      ageHours: best.timestamp ? Math.round(((nowMs - Date.parse(best.timestamp)) / 3_600_000) * 10) / 10 : null,
      score: scoreOf(cargo, speed, best.purchasePrice),
    };
  });
  const ranked = offers.filter((o) => o.cargo > 0).sort((a, b) => b.score - a.score || a.price - b.price);
  const fast = ranked.filter((o) => o.speed > policy.fastAbove && o.price <= policy.affordableUnder);
  return {
    hulls: ranked.length,
    yardsRead: new Set(rows.map((r) => r.waypointSymbol)).size,
    ranked: ranked.slice(0, policy.limit),
    fastAndAffordable: fast.slice(0, policy.limit),
    note: fast.length
      ? `${fast.length} hull type(s) faster than ${policy.fastAbove} at or under ${policy.affordableUnder.toLocaleString("en-US")} credits.`
      : `No hull faster than ${policy.fastAbove} at or under ${policy.affordableUnder.toLocaleString("en-US")} credits in the ${new Set(rows.map((r) => r.waypointSymbol)).size} yards read so far.`,
  };
}
