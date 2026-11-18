/**
 * Economy health: is the fleet making money, or quietly losing it? (docs/economy-alerts-plan.md, docs/lessons-learned.md
 * "the domino week").
 *
 * On 2026-11-17/18 matched profit stayed positive all night while the fleet lost money: fresh systems stopped opening, margins
 * thinned, a big hull was bought on a thin wallet, and then traders crossed 5-10 gates at about 6k a jump. Each of those showed
 * in numbers the engine already had. This module reads those numbers and says, in one line each, what is going wrong.
 *
 * Pure: no I/O, no clock, no globals. The caller fills the input from the ledger, the fresh-system queue and the fleet
 * (src/ops/economy.ts) and passes `now`. Thresholds are a policy object backed by doctrine (economyAlerts and the economy*
 * clauses); policy off returns no findings. Advisory only: a finding carries a suggested tool call, nothing is applied.
 */

export type EconomyLevel = "warn" | "bad";

export type EconomyFindingId =
  | "jumpsOverProfit"
  | "netNegative"
  | "worthFalling"
  | "releaseDrought"
  | "marginDecay"
  | "smallHullJumping"
  | "cashStarved";

export interface EconomySuggestion {
  /** The call written out, e.g. "stcommand_set_ship_reach THEO-1 system". */
  action: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface EconomyFinding {
  id: EconomyFindingId;
  level: EconomyLevel;
  /** One plain-English line, e.g. "Jump fees 486k against 232k profit in the last hour (80 jumps)." */
  line: string;
  /** The figures the line was made from. */
  numbers: Record<string, number | string>;
  /** Set on a per-ship finding (smallHullJumping). */
  ship?: string;
  suggestion?: EconomySuggestion;
}

/** One time bucket of the ledger (the caller uses 30 minutes). Costs are positive credits. */
export interface EconomyBucket {
  startMs: number;
  /** Matched profit: realized profit on sells. */
  profit: number;
  sales: number;
  jumps: number;
  jumpFees: number;
  fuel: number;
  /** Credits spent on hulls in this bucket (purchases only). */
  hullSpend: number;
  hullsBought: number;
}

export interface EconomyShip {
  symbol: string;
  cargo: number;
  /** Over the input's shipWindowHours. */
  jumps: number;
  jumpFees: number;
  profit: number;
}

export interface EconomyHealthInput {
  now: number;
  /** Width of each bucket, minutes (30). */
  bucketMin: number;
  /** Oldest first, contiguous, the newest ending at `now`. Six hours is enough for every rule. */
  buckets: readonly EconomyBucket[];
  /** Wallet plus holds samples, oldest first. The newest is "now". */
  worth: readonly { at: number; worth: number }[];
  /** Wallet samples (ledger wallet_after rows plus the live figure), oldest first. */
  wallet: readonly { at: number; wallet: number }[];
  walletNow: number;
  /** The working-capital floor (buyAdvice.workingCapitalFloor), 0 when unknown. */
  floor: number;
  queue: {
    lastReleaseAt?: number;
    /** Staged (not held) systems waiting for release, best first. */
    staged: readonly string[];
    tourShips?: number;
    tourShipsFree?: number;
  };
  /** Trader hulls with their jumps and profit over the last shipWindowHours. */
  ships: readonly EconomyShip[];
  shipWindowHours: number;
  /** Settings in force, so a suggestion can name the change. */
  settings?: { positioningHops?: number };
}

export interface EconomyPolicy {
  on: boolean;
  /** Jump fees above this multiple of matched profit, in the last hour and the 30 minutes before it. */
  jumpsOverProfitRatio: number;
  netNegativeHours: number;
  worthFallingHours: number;
  releaseDroughtHours: number;
  /** Profit per sale (last hour) under this share of its 6-hour average, 0-1. */
  marginDecayShare: number;
  /** At least this many sales in the last hour before margin decay is judged. */
  marginMinSales: number;
  smallHullCargo: number;
  smallHullJumpsPerHour: number;
  cashStarvedMin: number;
}

export const DEFAULT_ECONOMY_POLICY: EconomyPolicy = {
  on: true,
  jumpsOverProfitRatio: 1,
  netNegativeHours: 2,
  worthFallingHours: 2,
  releaseDroughtHours: 3,
  marginDecayShare: 0.5,
  marginMinSales: 5,
  smallHullCargo: 40,
  smallHullJumpsPerHour: 6,
  cashStarvedMin: 30,
};

export const ECONOMY_OFF: EconomyPolicy = { ...DEFAULT_ECONOMY_POLICY, on: false };

const HOUR = 3_600_000;

/** 486k, 1.19M, 950, -290k. */
export function fmtCredits(n: number): string {
  const a = Math.abs(n);
  const sg = n < 0 ? "-" : "";
  if (a >= 1e6) return `${sg}${(a / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (a >= 1e4) return `${sg}${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${sg}${(a / 1e3).toFixed(1)}k`;
  return `${sg}${Math.round(a)}`;
}

/** "about 290k": rounded to two significant figures. */
function approx(n: number): string {
  const a = Math.abs(n);
  if (a < 100) return fmtCredits(n);
  const mag = 10 ** (Math.floor(Math.log10(a)) - 1);
  return fmtCredits(Math.round(n / mag) * mag);
}

const hrs = (h: number): string => `${Number.isInteger(h) ? h : h.toFixed(1)} h`;

interface Sum { profit: number; sales: number; jumps: number; jumpFees: number; fuel: number; hullSpend: number; hullsBought: number }
const ZERO: Sum = { profit: 0, sales: 0, jumps: 0, jumpFees: 0, fuel: 0, hullSpend: 0, hullsBought: 0 };

/** Sum the buckets that start in [from, to). */
function sumWindow(buckets: readonly EconomyBucket[], from: number, to: number): Sum {
  const s = { ...ZERO };
  for (const b of buckets) {
    if (b.startMs < from || b.startMs >= to) continue;
    s.profit += b.profit; s.sales += b.sales; s.jumps += b.jumps; s.jumpFees += b.jumpFees; s.fuel += b.fuel;
    s.hullSpend += b.hullSpend; s.hullsBought += b.hullsBought;
  }
  return s;
}

/** The window ending `endAgoMs` before now and `lenMs` long, aligned to the input's buckets. */
function windowAt(input: EconomyHealthInput, endAgoMs: number, lenMs: number): Sum {
  const end = input.now - endAgoMs;
  // Buckets are keyed by their start; a bucket belongs to the window when it starts within (end - len - half a bucket, end - half a bucket].
  const half = (input.bucketMin * 60_000) / 2;
  return sumWindow(input.buckets, end - lenMs - half, end - half);
}

/** Latest sample at or before `t`, if it is no older than `maxAgeMs` before `t`. */
function sampleAt<T extends { at: number }>(samples: readonly T[], t: number, maxAgeMs: number): T | undefined {
  let best: T | undefined;
  for (const s of samples) if (s.at <= t && (!best || s.at > best.at)) best = s;
  return best && t - best.at <= maxAgeMs ? best : undefined;
}

const RANK: Record<EconomyLevel, number> = { bad: 0, warn: 1 };
const ORDER: EconomyFindingId[] = ["netNegative", "jumpsOverProfit", "cashStarved", "worthFalling", "releaseDrought", "marginDecay", "smallHullJumping"];

/** Worst first: bad before warn, then by the order above. */
export function sortFindings(list: readonly EconomyFinding[]): EconomyFinding[] {
  return [...list].sort((a, b) => RANK[a.level] - RANK[b.level] || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

function jumpsOverProfit(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding | undefined {
  const h1 = windowAt(input, 0, HOUR);
  const before = windowAt(input, HOUR, HOUR / 2);
  if (!(h1.jumpFees > 0) || !(h1.jumpFees > Math.max(0, h1.profit) * p.jumpsOverProfitRatio)) return undefined;
  // The half hour before must agree, unless it had no trading and no jumps at all (nothing to judge).
  const beforeActive = before.jumps > 0 || before.sales > 0;
  if (beforeActive && !(before.jumpFees > Math.max(0, before.profit) * p.jumpsOverProfitRatio)) return undefined;
  const hops = input.settings?.positioningHops;
  return {
    id: "jumpsOverProfit",
    level: h1.jumpFees > Math.max(0, h1.profit) * 1.5 ? "bad" : "warn",
    line: `Jump fees ${fmtCredits(h1.jumpFees)} against ${fmtCredits(h1.profit)} profit in the last hour (${h1.jumps} jumps).`,
    numbers: { jumpFees: Math.round(h1.jumpFees), profit: Math.round(h1.profit), jumps: h1.jumps, jumpFeesBefore: Math.round(before.jumpFees), profitBefore: Math.round(before.profit) },
    ...(hops !== undefined && hops > 3
      ? { suggestion: { action: "stcommand_set_doctrine positioningHops 3", tool: "stcommand_set_doctrine", args: { key: "positioningHops", value: 3 }, why: `traders may cross up to ${hops} gates to start a route; fewer gates means fewer fees` } }
      : { suggestion: { action: "stcommand_ops_dispatch_explain", tool: "stcommand_ops_dispatch_explain", args: {}, why: "see which ships are being sent across gates, then keep small hulls local (stcommand_set_ship_reach <ship> system)" } }),
  };
}

function netNegative(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding | undefined {
  const n = Math.max(1, Math.round(p.netNegativeHours));
  const nets: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = windowAt(input, i * HOUR, HOUR);
    if (w.sales === 0 && w.jumps === 0) return undefined; // an hour with nothing happening is not a loss to report
    nets.push(w.profit - w.jumpFees - w.fuel);
  }
  if (!nets.every((x) => x < 0)) return undefined;
  const avg = nets.reduce((a, b) => a + b, 0) / n;
  return {
    id: "netNegative",
    level: "bad",
    line: `Losing about ${approx(-avg)} an hour after jumps and fuel${n > 1 ? ` (${n} hours running)` : ""}.`,
    numbers: { hours: n, netPerHour: Math.round(avg), lastHourNet: Math.round(nets[0]!) },
  };
}

function worthFalling(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding | undefined {
  const n = Math.max(1, Math.round(p.worthFallingHours));
  const tol = 20 * 60_000;
  const points: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = sampleAt(input.worth, input.now - i * HOUR, tol);
    if (!s) return undefined;
    points.push(s.worth);
  }
  let spend = 0;
  let hulls = 0;
  // points[0] is now, points[i] is i hours ago. Each hour must be down after adding back the hulls bought in it.
  for (let i = 0; i < n; i++) {
    const w = windowAt(input, i * HOUR, HOUR);
    spend += w.hullSpend;
    hulls += w.hullsBought;
    if (!(points[i]! + w.hullSpend < points[i + 1]!)) return undefined;
  }
  const start = points[n]!;
  const end = points[0]!;
  const drop = start - (end + spend);
  return {
    id: "worthFalling",
    level: start > 0 && drop / start > 0.25 ? "bad" : "warn",
    line: `Wallet plus holds ${fmtCredits(start)} -> ${fmtCredits(end)} in ${hrs(n)} (${hulls === 0 ? "no hulls bought" : `${hulls} hull${hulls === 1 ? "" : "s"}, ${fmtCredits(spend)}, added back`}).`,
    numbers: { hours: n, from: Math.round(start), to: Math.round(end), hullSpend: Math.round(spend), hullsBought: hulls, dropAfterHulls: Math.round(drop) },
  };
}

function releaseDrought(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding | undefined {
  const q = input.queue;
  if (q.lastReleaseAt === undefined || q.staged.length === 0) return undefined;
  const gapH = (input.now - q.lastReleaseAt) / HOUR;
  if (gapH < p.releaseDroughtHours) return undefined;
  const tours = q.tourShips === undefined ? "" : q.tourShips === 0 ? ", no tour ships" : q.tourShipsFree === 0 ? ", all tour ships busy" : q.tourShipsFree !== undefined ? `, ${q.tourShipsFree} tour ship${q.tourShipsFree === 1 ? "" : "s"} free` : "";
  const first = q.staged[0]!;
  return {
    id: "releaseDrought",
    level: gapH >= p.releaseDroughtHours * 1.5 ? "bad" : "warn",
    line: `No system opened for ${hrs(Math.floor(gapH * 2) / 2)}; ${q.staged.length} staged waiting${tours}.`,
    numbers: { hoursSinceRelease: Math.round(gapH * 10) / 10, staged: q.staged.length, ...(q.tourShips !== undefined ? { tourShips: q.tourShips } : {}), ...(q.tourShipsFree !== undefined ? { tourShipsFree: q.tourShipsFree } : {}) },
    suggestion: { action: `stcommand_release_system ${first}`, tool: "stcommand_release_system", args: { system: first }, why: "fresh systems pay about 1.7x for some hours; check stcommand_ops_system_queue first" },
  };
}

function marginDecay(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding | undefined {
  const h1 = windowAt(input, 0, HOUR);
  const h6 = windowAt(input, 0, 6 * HOUR);
  if (h1.sales < p.marginMinSales || h6.sales < p.marginMinSales * 2) return undefined;
  const now = h1.profit / h1.sales;
  const avg = h6.profit / h6.sales;
  if (!(avg > 0) || !(now < avg * p.marginDecayShare)) return undefined;
  return {
    id: "marginDecay",
    level: now < avg * p.marginDecayShare * 0.5 ? "bad" : "warn",
    line: `Profit per sale ${fmtCredits(now)} against ${fmtCredits(avg)} (6 h avg).`,
    numbers: { perSaleNow: Math.round(now), perSale6h: Math.round(avg), salesLastHour: h1.sales, sales6h: h6.sales },
    suggestion: { action: "stcommand_ops_system_queue", tool: "stcommand_ops_system_queue", args: {}, why: "falling margins usually mean no fresh system: fix the pipeline before buying hulls" },
  };
}

function smallHullJumping(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding[] {
  const h = Math.max(0.5, input.shipWindowHours);
  return input.ships
    .filter((s) => s.cargo > 0 && s.cargo <= p.smallHullCargo && s.jumps / h > p.smallHullJumpsPerHour)
    .sort((a, b) => b.jumps - a.jumps)
    .slice(0, 5)
    .map((s) => ({
      id: "smallHullJumping" as const,
      level: (s.jumpFees > s.profit ? "bad" : "warn") as EconomyLevel,
      ship: s.symbol,
      line: `${s.symbol} (${s.cargo} cargo): ${Math.round(s.jumps / h)} jumps an hour, ${fmtCredits(s.profit / h)} profit.`,
      numbers: { cargo: s.cargo, jumpsPerHour: Math.round((s.jumps / h) * 10) / 10, profitPerHour: Math.round(s.profit / h), jumpFees: Math.round(s.jumpFees), jumps: s.jumps, hours: h },
      suggestion: { action: `stcommand_set_ship_reach ${s.symbol} system`, tool: "stcommand_set_ship_reach", args: { shipSymbol: s.symbol, reach: "system" }, why: "a local-only ship never pays positioning jumps" },
    }));
}

/** Cargo value now: the newest wallet-plus-holds sample less the wallet. 0 when unknown. */
function holdsNow(input: EconomyHealthInput): number {
  const last = input.worth[input.worth.length - 1];
  return last ? Math.max(0, last.worth - input.walletNow) : 0;
}

function cashStarved(input: EconomyHealthInput, p: EconomyPolicy): EconomyFinding | undefined {
  if (!(input.floor > 0) || !(input.walletNow < input.floor)) return undefined;
  const since = input.now - p.cashStarvedMin * 60_000;
  // Under the floor at the start of the window (the last reading at or before it) and at every reading since.
  const atStart = sampleAt(input.wallet, since, 6 * HOUR);
  if (!atStart || !(atStart.wallet < input.floor)) return undefined;
  if (input.wallet.some((s) => s.at > since && s.wallet >= input.floor)) return undefined;
  return {
    id: "cashStarved",
    level: input.walletNow < input.floor * 0.25 ? "bad" : "warn",
    line: `Wallet ${fmtCredits(input.walletNow)}${holdsNow(input) > 0 ? ` (${fmtCredits(holdsNow(input))} in cargo)` : ""}, floor ${fmtCredits(input.floor)}: traders can't load fully.`,
    numbers: { wallet: Math.round(input.walletNow), holds: Math.round(holdsNow(input)), floor: Math.round(input.floor), minutes: p.cashStarvedMin },
  };
}

/** Every finding the numbers support, worst first. Policy off: none. */
export function economyHealth(input: EconomyHealthInput, policy: EconomyPolicy = DEFAULT_ECONOMY_POLICY): EconomyFinding[] {
  if (!policy.on) return [];
  const out: EconomyFinding[] = [];
  for (const f of [jumpsOverProfit(input, policy), netNegative(input, policy), worthFalling(input, policy), releaseDrought(input, policy), marginDecay(input, policy), cashStarved(input, policy)]) {
    if (f) out.push(f);
  }
  out.push(...smallHullJumping(input, policy));
  return sortFindings(out);
}

// ---- Building the input from ledger rows (pure; the caller does the read) ----

export interface EconomyLedgerRow {
  ts: number;
  ship: string | null;
  type: string;
  total: number;
  pnl: number | null;
  wallet: number | null;
}

/**
 * Roll ledger rows into `hours` of contiguous buckets ending at `now` (oldest first). JUMP, REFUEL and SHIP totals are positive
 * costs in this ledger; a SHIP row with a negative total (a scrap refund) or a REPAIR is not a hull bought.
 */
export function bucketsFromLedger(rows: readonly EconomyLedgerRow[], now: number, bucketMin: number, hours: number): EconomyBucket[] {
  const size = bucketMin * 60_000;
  const n = Math.max(1, Math.ceil((hours * 60) / bucketMin));
  const first = now - n * size;
  const out: EconomyBucket[] = Array.from({ length: n }, (_, i) => ({ startMs: first + i * size, profit: 0, sales: 0, jumps: 0, jumpFees: 0, fuel: 0, hullSpend: 0, hullsBought: 0 }));
  for (const r of rows) {
    if (r.ts < first || r.ts >= now) continue;
    const b = out[Math.min(n - 1, Math.floor((r.ts - first) / size))]!;
    if (r.type === "SELL") { b.sales += 1; b.profit += r.pnl ?? 0; }
    else if (r.type === "JUMP") { b.jumps += 1; b.jumpFees += Math.abs(r.total); }
    else if (r.type === "REFUEL") b.fuel += Math.abs(r.total);
    else if (r.type === "SHIP" && r.total > 0) { b.hullSpend += r.total; b.hullsBought += 1; }
  }
  return out;
}

/** Per-ship jumps, jump fees and matched profit since `sinceMs`, for the ships named in `cargoBy` (traders, by cargo capacity). */
export function shipStatsFromLedger(rows: readonly EconomyLedgerRow[], sinceMs: number, cargoBy: ReadonlyMap<string, number>): EconomyShip[] {
  const by = new Map<string, EconomyShip>();
  for (const [symbol, cargo] of cargoBy) by.set(symbol, { symbol, cargo, jumps: 0, jumpFees: 0, profit: 0 });
  for (const r of rows) {
    if (r.ts < sinceMs || !r.ship) continue;
    const s = by.get(r.ship);
    if (!s) continue;
    if (r.type === "JUMP") { s.jumps += 1; s.jumpFees += Math.abs(r.total); }
    else if (r.type === "SELL") s.profit += r.pnl ?? 0;
  }
  return [...by.values()];
}

/** The doctrine-backed policy. `read` is the doctrine (value(key, whenOff) / isEnabledOr(key, fallback)). */
export function economyPolicyFrom(d: { value(key: string, whenOff?: number): number; isEnabledOr(key: string, fallback: boolean): boolean }): EconomyPolicy {
  if (!d.isEnabledOr("economyAlerts", true)) return ECONOMY_OFF;
  const v = (key: string, def: number) => (d.isEnabledOr(key, true) ? d.value(key, def) : def);
  return {
    ...DEFAULT_ECONOMY_POLICY,
    releaseDroughtHours: v("economyDroughtHours", DEFAULT_ECONOMY_POLICY.releaseDroughtHours),
    smallHullJumpsPerHour: v("economySmallHullJumps", DEFAULT_ECONOMY_POLICY.smallHullJumpsPerHour),
    smallHullCargo: v("economySmallHullCargo", DEFAULT_ECONOMY_POLICY.smallHullCargo),
    marginDecayShare: v("economyMarginDecayPct", DEFAULT_ECONOMY_POLICY.marginDecayShare * 100) / 100,
    netNegativeHours: v("economyNetNegativeHours", DEFAULT_ECONOMY_POLICY.netNegativeHours),
    cashStarvedMin: v("economyCashStarvedMin", DEFAULT_ECONOMY_POLICY.cashStarvedMin),
  };
}
