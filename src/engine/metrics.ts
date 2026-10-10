/**
 * Financial metrics: what the fleet earned and spent over a window, broken down for planning.
 *
 * Pure: no I/O, no clock. The caller reads ledger rows (the window plus the one before it, for the comparison) and passes
 * `now`, so the same rows always give the same answer. "Net trading" is the same figure the front page's pace uses:
 * realized profit on completed sales (a SELL's `pnl`, proceeds less that ship's own cost basis) minus fuel and jumps. Cargo
 * bought but not yet sold, ship purchases and scrap proceeds are kept apart so the line does not dip when traders load up
 * or you expand the fleet.
 */

export interface LedgerRow {
  /** Epoch ms. */
  ts: number;
  ship: string;
  waypoint: string;
  /** PURCHASE | SELL | REFUEL | JUMP | SHIP | OTHER */
  type: string;
  good: string | null;
  units: number;
  /** Always a positive magnitude; direction comes from `type`. */
  total: number;
  /** Realized profit on a SELL with a tracked cost basis; null otherwise. */
  pnl: number | null;
  /** The agent's credits right after this row, when known. */
  wallet: number | null;
}

export interface MetricsOptions {
  now: number;
  hours: number;
  bucketMinutes: number;
  /** Cargo capacity per ship, to show hold size beside each ship's earnings. */
  holds?: Record<string, number>;
  /** Ships that should be trading, so those with no sale in the window can be listed. */
  traders?: string[];
}

export interface MetricsBucket {
  /** Bucket start, epoch ms. */
  t: number;
  /** Realized profit less fuel and jumps. */
  net: number;
  /** Net trading summed from the start of the window to the end of this bucket. */
  cumNet: number;
  revenue: number;
  /** Credits spent on cargo in this bucket (purchases only; ship buys are not here). */
  spend: number;
  /** Units of cargo bought in this bucket. */
  unitsBought: number;
  /** Average price paid per unit bought in this bucket, or null when nothing was bought. Rising over a window is our own buying pushing the market up. */
  avgBuy: number | null;
  sells: number;
  /** Credits at the end of the bucket (carried forward when no row carried one), or null before any is known. */
  wallet: number | null;
}

export interface MetricsTotals {
  /** Realized profit less fuel and jumps: the pace figure. */
  net: number;
  /** Realized profit on completed sales. */
  profit: number;
  fuel: number;
  jumps: number;
  /** Gross sale proceeds, all sales. */
  revenue: number;
  /** Gross cargo purchases. */
  spend: number;
  /** Sale proceeds with no cost basis (mined or siphoned cargo, say), left out of `profit`. */
  unmatchedRevenue: number;
  sells: number;
  units: number;
  /** Ship purchases (credits spent) and scrap (credits received). */
  shipsBought: number;
  shipsBoughtCount: number;
  scrapProceeds: number;
  /** Profit per completed sale with a cost basis. */
  profitPerSale: number;
  /** Profit as a share of the cost basis of those sales. */
  marginPct: number;
  /** Fuel and jumps as a share of gross profit, 0 when there is none. */
  overheadPct: number;
  netPerHour: number;
}

export interface MetricsGood { good: string; profit: number; units: number; sells: number; profitPerUnit: number; marginPct: number }
export interface MetricsShip { ship: string; hold: number | null; profit: number; sells: number; profitPerSale: number; profitPerHour: number }
export interface MetricsSystem { system: string; profit: number; sells: number }

export interface Metrics {
  hours: number;
  bucketMinutes: number;
  from: number;
  to: number;
  buckets: MetricsBucket[];
  totals: MetricsTotals;
  /** The window just before this one, same length, for comparison. */
  previous: Pick<MetricsTotals, "net" | "profit" | "sells" | "netPerHour">;
  walletStart: number | null;
  walletEnd: number | null;
  byGood: MetricsGood[];
  byShip: MetricsShip[];
  bySystem: MetricsSystem[];
  /** Traders that made no sale in the window. */
  idleTraders: string[];
}

const HOUR = 3_600_000;
const systemOf = (waypoint: string): string => waypoint.slice(0, waypoint.lastIndexOf("-"));
const rnd = (n: number): number => Math.round(n);

function totalsOf(rows: readonly LedgerRow[], hours: number): MetricsTotals {
  let profit = 0, fuel = 0, jumps = 0, revenue = 0, spend = 0, unmatchedRevenue = 0, sells = 0, units = 0;
  let shipsBought = 0, shipsBoughtCount = 0, scrapProceeds = 0, matchedSells = 0, matchedRevenue = 0;
  for (const r of rows) {
    switch (r.type) {
      case "SELL":
        sells += 1; units += r.units; revenue += r.total;
        if (r.pnl === null) unmatchedRevenue += r.total;
        else { profit += r.pnl; matchedSells += 1; matchedRevenue += r.total; }
        break;
      case "PURCHASE": spend += r.total; break;
      case "REFUEL": fuel += r.total; break;
      case "JUMP": jumps += r.total; break;
      case "SHIP":
        if (r.good === "SCRAP") scrapProceeds += r.total;
        else { shipsBought += r.total; shipsBoughtCount += 1; }
        break;
    }
  }
  const net = profit - fuel - jumps;
  const cost = matchedRevenue - profit;
  return {
    net: rnd(net), profit: rnd(profit), fuel: rnd(fuel), jumps: rnd(jumps), revenue: rnd(revenue), spend: rnd(spend),
    unmatchedRevenue: rnd(unmatchedRevenue), sells, units, shipsBought: rnd(shipsBought), shipsBoughtCount, scrapProceeds: rnd(scrapProceeds),
    profitPerSale: matchedSells ? rnd(profit / matchedSells) : 0,
    marginPct: cost > 0 ? Math.round((profit / cost) * 1000) / 10 : 0,
    overheadPct: profit > 0 ? Math.round(((fuel + jumps) / profit) * 1000) / 10 : 0,
    netPerHour: hours > 0 ? rnd(net / hours) : 0,
  };
}

export function buildMetrics(rows: readonly LedgerRow[], opts: MetricsOptions): Metrics {
  const { now, hours, bucketMinutes } = opts;
  const size = bucketMinutes * 60_000;
  const count = Math.max(1, Math.ceil((hours * HOUR) / size));
  const from = now - count * size;
  const prevFrom = from - count * size;
  const inWindow = rows.filter((r) => r.ts >= from && r.ts <= now).sort((a, b) => a.ts - b.ts);
  const inPrevious = rows.filter((r) => r.ts >= prevFrom && r.ts < from);
  const windowHours = (count * size) / HOUR;

  // Buckets: per-bucket totals, then running sums and the wallet carried forward.
  const buckets: MetricsBucket[] = Array.from({ length: count }, (_, i) => ({ t: from + i * size, net: 0, cumNet: 0, revenue: 0, spend: 0, unitsBought: 0, avgBuy: null, sells: 0, wallet: null }));
  // The wallet before the window starts, so the line does not begin blank.
  const lastWalletBefore = rows.filter((r) => r.ts < from && r.wallet !== null).sort((a, b) => a.ts - b.ts).at(-1)?.wallet ?? null;
  let wallet: number | null = lastWalletBefore;
  const walletStart = lastWalletBefore ?? inWindow.find((r) => r.wallet !== null)?.wallet ?? null;
  const lastWalletInBucket: (number | null)[] = Array(count).fill(null);
  for (const r of inWindow) {
    const b = buckets[Math.min(count - 1, Math.floor((r.ts - from) / size))]!;
    if (r.type === "SELL") { b.revenue += r.total; b.sells += 1; b.net += r.pnl ?? 0; }
    else if (r.type === "PURCHASE") { b.spend += r.total; b.unitsBought += r.units; }
    else if (r.type === "REFUEL" || r.type === "JUMP") b.net -= r.total;
    if (r.wallet !== null) lastWalletInBucket[Math.min(count - 1, Math.floor((r.ts - from) / size))] = r.wallet;
  }
  let cum = 0;
  buckets.forEach((b, i) => {
    cum += b.net;
    b.avgBuy = b.unitsBought > 0 ? rnd(b.spend / b.unitsBought) : null;
    b.net = rnd(b.net); b.cumNet = rnd(cum); b.revenue = rnd(b.revenue); b.spend = rnd(b.spend);
    wallet = lastWalletInBucket[i] ?? wallet;
    b.wallet = wallet;
  });

  const totals = totalsOf(inWindow, windowHours);
  const prev = totalsOf(inPrevious, windowHours);

  // Breakdowns, over completed sales only.
  const goods = new Map<string, { profit: number; units: number; sells: number; revenue: number; matchedRevenue: number }>();
  const ships = new Map<string, { profit: number; sells: number }>();
  const systems = new Map<string, { profit: number; sells: number }>();
  for (const r of inWindow) {
    if (r.type !== "SELL" || r.pnl === null) continue;
    const g = goods.get(r.good ?? "?") ?? { profit: 0, units: 0, sells: 0, revenue: 0, matchedRevenue: 0 };
    g.profit += r.pnl; g.units += r.units; g.sells += 1; g.matchedRevenue += r.total;
    goods.set(r.good ?? "?", g);
    const s = ships.get(r.ship) ?? { profit: 0, sells: 0 };
    s.profit += r.pnl; s.sells += 1;
    ships.set(r.ship, s);
    const sys = systemOf(r.waypoint);
    const y = systems.get(sys) ?? { profit: 0, sells: 0 };
    y.profit += r.pnl; y.sells += 1;
    systems.set(sys, y);
  }
  const byGood = [...goods.entries()]
    .map(([good, g]) => {
      const cost = g.matchedRevenue - g.profit;
      return { good, profit: rnd(g.profit), units: g.units, sells: g.sells, profitPerUnit: g.units ? rnd(g.profit / g.units) : 0, marginPct: cost > 0 ? Math.round((g.profit / cost) * 1000) / 10 : 0 };
    })
    .sort((a, b) => b.profit - a.profit);
  const byShip = [...ships.entries()]
    .map(([ship, s]) => ({ ship, hold: opts.holds?.[ship] ?? null, profit: rnd(s.profit), sells: s.sells, profitPerSale: s.sells ? rnd(s.profit / s.sells) : 0, profitPerHour: windowHours > 0 ? rnd(s.profit / windowHours) : 0 }))
    .sort((a, b) => b.profit - a.profit);
  const bySystem = [...systems.entries()].map(([system, s]) => ({ system, profit: rnd(s.profit), sells: s.sells })).sort((a, b) => b.profit - a.profit);
  const idleTraders = (opts.traders ?? []).filter((t) => !ships.has(t)).sort();

  return {
    hours, bucketMinutes, from, to: now, buckets, totals,
    previous: { net: prev.net, profit: prev.profit, sells: prev.sells, netPerHour: prev.netPerHour },
    walletStart, walletEnd: buckets.at(-1)?.wallet ?? walletStart,
    byGood, byShip, bySystem, idleTraders,
  };
}

/** Bucket width that keeps a chart around 48-96 points for each range. */
export function bucketMinutesFor(hours: number): number {
  if (hours <= 1) return 2;
  if (hours <= 6) return 10;
  if (hours <= 24) return 30;
  if (hours <= 72) return 60;
  return 180;
}

/**
 * Where the fleet ends up at reset if it keeps earning at `perHour`: wallet plus holds now, plus the rate times the hours
 * left. A straight line, not a forecast; it is there to say whether the pace is enough for a target.
 */
export function projectToReset(current: number, perHour: number, hoursLeft: number): number {
  return rnd(current + perHour * Math.max(0, hoursLeft));
}

/** The hourly rate needed from now to reach `target` by reset (0 when already past it or no time is left). */
export function rateNeeded(current: number, target: number, hoursLeft: number): number {
  return hoursLeft > 0 && target > current ? rnd((target - current) / hoursLeft) : 0;
}

export interface WealthSample { ts: number; worth: number }

/**
 * Credits plus holds at the end of each bucket, carried forward over buckets with no sample and null before the
 * first one. A sample belongs to the bucket it falls in; when a bucket has several, the latest wins.
 */
export function worthByBucket(bucketStarts: readonly number[], bucketMinutes: number, samples: readonly WealthSample[]): (number | null)[] {
  const size = bucketMinutes * 60_000;
  const last: (number | null)[] = Array(bucketStarts.length).fill(null);
  const from = bucketStarts[0] ?? 0;
  for (const s of [...samples].sort((a, b) => a.ts - b.ts)) {
    const i = Math.min(bucketStarts.length - 1, Math.floor((s.ts - from) / size));
    if (i >= 0 && s.ts >= from) last[i] = s.worth;
  }
  let carry: number | null = null;
  return last.map((v) => (carry = v ?? carry));
}
