import type { Store } from "../db/store.js";
import type { FleetManager } from "../engine/fleet.js";
import { bucketsFromLedger, economyHealth, economyPolicyFrom, shipStatsFromLedger, type EconomyFinding, type EconomyHealthInput, type EconomyLedgerRow } from "../engine/economyHealth.js";
import { hullCargo, buyAdvice, buyRulesFrom, workingCapitalFloor, type BuyAdvice, type BuyRules } from "../engine/buyAdvice.js";

/**
 * The thin source for the economy alerts and the buy-ship warning: reads what the engine already has (the ledger, wealth
 * samples, cargo values, the fresh-system queue, the fleet summary) into the pure modules' inputs, and runs them.
 * economyHealth.ts and buyAdvice.ts hold every rule; this file only fetches.
 */

export interface EconomyDeps {
  tenantId: string;
  store: Pick<Store, "ledgerRowsSince" | "wealthSamplesSince" | "shipyardInventory">;
  fleet: Pick<FleetManager, "fleetStatusSummary" | "cargoValues" | "walletCredits" | "idleTraders" | "economyQueueFacts" | "doctrine">;
}

const HOUR = 3_600_000;
const BUCKET_MIN = 30;
const SHIP_WINDOW_H = 2;

export interface EconomyReport {
  asOf: string;
  on: boolean;
  findings: EconomyFinding[];
  /** The figures the findings were judged on, for a reader who wants to check them. */
  summary: {
    wallet: number; holds: number; floor: number; traders: number; bigHulls: number;
    lastHour: { profit: number; sales: number; jumps: number; jumpFees: number; fuel: number; net: number };
    lastReleaseAt: string | null; staged: number; tourShips: number; tourShipsFree: number;
  };
}

interface Loaded {
  now: number;
  rows: EconomyLedgerRow[];
  input: EconomyHealthInput;
  findings: EconomyFinding[];
  rules: BuyRules;
  traders: { symbol: string; cargo: number }[];
  bigHulls: number;
  holds: number;
  on: boolean;
}

async function load(deps: EconomyDeps, now: number): Promise<Loaded> {
  const doctrine = deps.fleet.doctrine;
  const policy = economyPolicyFrom(doctrine);
  const rules = buyRulesFrom(doctrine);
  const lookbackH = Math.max(6, rules.paybackHours) + 0.5;
  const sinceIso = new Date(now - lookbackH * HOUR).toISOString();
  const [ledger, samples, values] = await Promise.all([
    deps.store.ledgerRowsSince(deps.tenantId, sinceIso),
    deps.store.wealthSamplesSince(deps.tenantId, new Date(now - 3.5 * HOUR).toISOString()).catch(() => []),
    deps.fleet.cargoValues().catch(() => ({})),
  ]);
  const rows: EconomyLedgerRow[] = ledger.map((r) => ({ ts: r.ts, ship: r.ship, type: r.type, total: r.total, pnl: r.pnl, wallet: r.wallet }));
  const holds = Object.values(values as Record<string, { value?: number }>).reduce((n, v) => n + Math.max(0, v?.value ?? 0), 0);
  const wallet = deps.fleet.walletCredits();
  const traders = deps.fleet.fleetStatusSummary().filter((s) => s.role === "trader").map((s) => ({ symbol: s.symbol, cargo: s.cargoCap }));
  const bigHulls = traders.filter((t) => t.cargo > rules.bigHullCargo).length;
  const floor = workingCapitalFloor(bigHulls, traders.length - bigHulls, rules);
  const q = deps.fleet.economyQueueFacts();
  const input: EconomyHealthInput = {
    now,
    bucketMin: BUCKET_MIN,
    buckets: bucketsFromLedger(rows, now, BUCKET_MIN, 6),
    worth: [...samples.map((s) => ({ at: s.ts, worth: s.worth })), { at: now, worth: wallet + holds }],
    wallet: [...rows.filter((r) => r.wallet !== null).map((r) => ({ at: r.ts, wallet: r.wallet as number })), { at: now, wallet }],
    walletNow: wallet,
    floor,
    queue: q,
    ships: shipStatsFromLedger(rows, now - SHIP_WINDOW_H * HOUR, new Map(traders.map((t) => [t.symbol, t.cargo]))),
    shipWindowHours: SHIP_WINDOW_H,
    settings: { positioningHops: doctrine.value("positioningHops", 3) },
  };
  return { now, rows, input, findings: economyHealth(input, policy), rules, traders, bigHulls, holds, on: policy.on };
}

/** Ops `economy_health`: the findings, worst first, with the figures behind them. */
export async function economyReport(deps: EconomyDeps, now: number = Date.now()): Promise<EconomyReport> {
  const l = await load(deps, now);
  const h1 = l.input.buckets.filter((b) => b.startMs >= now - HOUR - 1).reduce(
    (s, b) => ({ profit: s.profit + b.profit, sales: s.sales + b.sales, jumps: s.jumps + b.jumps, jumpFees: s.jumpFees + b.jumpFees, fuel: s.fuel + b.fuel }),
    { profit: 0, sales: 0, jumps: 0, jumpFees: 0, fuel: 0 },
  );
  const q = l.input.queue;
  return {
    asOf: new Date(now).toISOString(),
    on: l.on,
    findings: l.findings,
    summary: {
      wallet: Math.round(l.input.walletNow), holds: Math.round(l.holds), floor: l.input.floor, traders: l.traders.length, bigHulls: l.bigHulls,
      lastHour: { ...h1, profit: Math.round(h1.profit), jumpFees: Math.round(h1.jumpFees), fuel: Math.round(h1.fuel), net: Math.round(h1.profit - h1.jumpFees - h1.fuel) },
      lastReleaseAt: q.lastReleaseAt ? new Date(q.lastReleaseAt).toISOString() : null, staged: q.staged.length, tourShips: q.tourShips ?? 0, tourShipsFree: q.tourShipsFree ?? 0,
    },
  };
}

/** Just the findings, for the notification pass. */
export async function economyFindings(deps: EconomyDeps, now: number = Date.now()): Promise<EconomyFinding[]> {
  return (await load(deps, now)).findings;
}

export interface BuyPreflight extends BuyAdvice {
  shipType: string;
  yardSymbol: string;
  /** The yard's last known price, or null when the yard has no price on file for this hull. */
  price: number | null;
  cargo: number | null;
  wallet: number;
  holds: number;
}

/**
 * The buy-ship warning for one hull at one yard: price and cargo from the cached shipyard inventory, cash and fleet from the
 * engine, the last big hull's payback from the ledger. Warn only: nothing here blocks a purchase.
 */
export async function buyPreflight(deps: EconomyDeps, shipType: string, yardSymbol: string, now: number = Date.now()): Promise<BuyPreflight> {
  const [l, inventory] = await Promise.all([load(deps, now), deps.store.shipyardInventory().catch(() => [])]);
  const offer = inventory.find((x) => x.waypointSymbol === yardSymbol && x.shipType === shipType);
  const cargoBy = new Map(l.traders.map((t) => [t.symbol, t.cargo]));
  const bigBuys = l.rows.filter((r) => r.type === "SHIP" && r.total > 0 && r.ship && (cargoBy.get(r.ship) ?? 0) > l.rules.bigHullCargo);
  const lastBig = bigBuys.reduce<EconomyLedgerRow | undefined>((a, b) => (!a || b.ts > a.ts ? b : a), undefined);
  const lastBigHullBuy = lastBig
    ? {
        ship: lastBig.ship as string, price: lastBig.total, at: lastBig.ts,
        profitSince: l.rows.filter((r) => r.type === "SELL" && r.ship === lastBig.ship && r.ts >= lastBig.ts).reduce((n, r) => n + (r.pnl ?? 0), 0),
      }
    : undefined;
  // Escape clause: wallet plus holds (hulls bought added back) no higher than 2 hours ago, with traders idle.
  const worthThen = [...l.input.worth].filter((s) => s.at <= now - 2 * HOUR).pop();
  const spent2h = l.input.buckets.filter((b) => b.startMs >= now - 2 * HOUR - 1).reduce((n, b) => n + b.hullSpend, 0);
  const worthNow = l.input.walletNow + l.holds;
  const cashFlatOrFalling2h = worthThen !== undefined && now - worthThen.at < 2.5 * HOUR && worthNow + spent2h <= worthThen.worth * 1.02;
  const advice = buyAdvice({
    price: offer?.purchasePrice ?? 0,
    cargo: hullCargo(offer),
    wallet: l.input.walletNow,
    holds: l.holds,
    traders: l.traders.length,
    bigHulls: l.bigHulls,
    lastBigHullBuy,
    now,
    economyFindings: l.findings,
    escape: { cashFlatOrFalling2h, idleTraders: deps.fleet.idleTraders(now).length },
    rules: l.rules,
  });
  if (!offer && l.rules.on) advice.warnings.unshift(`No price on file for ${shipType} at ${yardSymbol}: the checks below assume a price of 0.`);
  return {
    ...advice,
    ok: advice.warnings.length === 0,
    shipType, yardSymbol,
    price: offer?.purchasePrice ?? null,
    cargo: offer ? hullCargo(offer) : null,
    wallet: Math.round(l.input.walletNow),
    holds: Math.round(l.holds),
  };
}
