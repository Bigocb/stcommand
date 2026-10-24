export interface DispatchRoute {
  good: string;
  buyAt: string;
  buySystem: string;
  buyPrice: number;
  sellAt: string;
  sellSystem: string;
  sellPrice: number;
  /** The trip's real ceiling — the largest hold in the fleet that could fly
   *  it, and what's affordable — not either market's own per-transaction
   *  limit. See computeDispatchRoutes()'s own comment. */
  volume: number;
  /** Each market's per-transaction trade-volume cap (the smaller of the two
   *  sides), for a buyer to chunk purchases against to actually reach
   *  `volume`. */
  lotSize: number;
  /** Each market's own trade volume (lotSize is the smaller). Optional for callers that only know the minimum. */
  buyVolume?: number;
  sellVolume?: number;
  distance: number;
  /** Tank-fuel burned over the round trip (both legs, BURN doubled). */
  fuelUnits: number;
  /** Fuel credits for the round trip, or the jump cost for a cross-system leg. */
  fuelCost: number;
  /** Our own price impact over the trip, both sides. */
  slippage?: number;
  /** Round-trip seconds (same-system only) and seconds per distance unit, for per-hour ranking and costing the positioning leg. */
  tripSeconds?: number;
  secPerDist?: number;
  /** Net per trip: spread - round-trip fuel - slippage. */
  profitPerTrip: number;
  /** The same trip's net priced at each trader hold size flying (units -> credits); profitPerTrip is the biggest hold's. */
  profitByHold?: Record<string, number>;
  ageMinutes: number;
}

/**
 * Flat, conservative per-jump cost estimate (credits) used wherever a route
 * crosses a system boundary. jumpShip() only reveals its real cost in the
 * transaction response *after* the jump — there is no pre-flight estimate
 * endpoint — and a leg's two waypoints live in unrelated per-system
 * coordinate spaces, so the usual distance-based fuel-cost formula (built on
 * Math.hypot() between x/y) is meaningless once buyAt and sellAt are in
 * different systems. This errs toward undercounting profit (a route that
 * looks marginal gets skipped) rather than overstating it, until real paid
 * jump costs give a basis for something better (e.g. a per-gate-pair
 * average learned from actual transactions).
 *
 * Placeholder value — tune against real jumpShip() transaction totals once
 * cross-system routes are actually flying.
 */
export const CROSS_SYSTEM_JUMP_COST_ESTIMATE = 5_000;

/**
 * How much one unit bought pushes a market's ask up, as a fraction. Measured
 * live 2026-10-02 at X1-SJ91-D54 (ADVANCED_CIRCUITRY, trade volume 20/lot): the
 * ask went 3,469 -> 3,783 -> 4,259 -> 4,656 across batches of 40, 40 and 28
 * units, i.e. ~9-12% per 40 units, ~0.25% per unit, and recovered only ~1-2% in
 * the ten minutes after. A placeholder until it is learned per market from the
 * snapshots; sells barely move a price by comparison (~0.04%/unit) so sell-side
 * impact is not modelled.
 *
 * 2026-10-03: briefly lowered to 0.12% (the median per-unit rise across 87
 * multi-lot buys in 24h) and put back. That measured the rise WITHIN one visit;
 * it says nothing about recovery, and recovery is the slow part — the 10-minute
 * 1-2% above still holds. Live, one freighter repeating a manually pinned
 * ADVANCED_CIRCUITRY run (plus three other hulls on the same good) took
 * TU85-E11E's ask from 4,178 to 7,992 in two hours and turned a +450k trip into
 * two losing ones. A conservative per-unit figure is the cheap protection until
 * recovery is modelled from the snapshots.
 *
 * Operator decision, same day: 0.20% per unit (0.002 as a fraction; briefly
 * mis-set to 0.2 = 20%/unit, which made any second buyer's predicted ask
 * astronomical and so allowed only one trader per good per buy market). 0.002
 * sits just under the measured 0.25%, so a second or third buyer is only sent
 * while the predicted ask still leaves margin. MAX_TRADERS_PER_BUY_MARKET below
 * is the hard backstop.
 */
export const BUY_IMPACT_PER_UNIT = 0.002;
// 2026-10-10: this flat figure is the fallback only. It was measured on a 20-unit market (4.5% per lot = 0.225%/unit);
// where a route carries the buy market's own lot size the per-unit impact is PRICE_IMPACT_PER_LOT / lot size instead (300-unit
// lots: 0.015%/unit), so a second hauler on a deep market is no longer priced as if it were a thin one.

/** Hard backstop: no more than this many traders are sent to buy the same good
 *  at the same market in one dispatch cycle, whatever the margin says. */
export const MAX_TRADERS_PER_BUY_MARKET = 3;

/** How long an assigned trip may sit without its cargo ever being bought
 *  (positioning jumps included) before the trader is released for new work. */
export const COMMIT_GRACE_MS = 3 * 60 * 60_000;
/** commitmentsSnapshot() of a dispatcher with nothing in flight. */
export const EMPTY_COMMITMENTS = JSON.stringify({ trips: [], committed: [] });

/** How long a leg a trader refused stays out of that trader's picks. */
export const DECLINE_MS = 15 * 60_000;

/**
 * How many of a market's own per-transaction lots a single trip is assumed
 * able to move at that market's flat buy/sell price, in both the ranking
 * model (fleet.ts's computeDispatchRoutes()) and the trader's own live
 * sizing (viableRoute()/freeChoice() in trader.ts) — shared so the two
 * never disagree on what "the trip's volume" means.
 *
 * A real market's depth beyond its advertised trade volume is not the rest
 * of a ship's cargo hold: each successive lot draws down supply and moves
 * the price further than a flat buyPrice/sellPrice can see. Confirmed
 * live: sizing a trip to a full 80-unit hold on a 20u/tx market (4 lots)
 * scored as profitable at the snapshot price and landed a real -40,540c
 * loss once the later lots actually executed at a crashed price.
 *
 * Placeholder value, same caveat as CROSS_SYSTEM_JUMP_COST_ESTIMATE above:
 * picked to fix the original bug (a trip capped at exactly one
 * transaction, which hid every route needing more than one) without
 * assuming unlimited market depth. Tune against real executed-trip totals
 * once there's a basis for something better than "a few lots."
 */
export const MAX_LOTS_PER_TRIP = 3;

import { coolOffReason, DEFAULT_HEAT_POLICY, type RouteTrip } from "./routeHeat.js";
import { estimateBuyPrice, estimateSellPrice, profitAfterShortfall, type SaleImpact } from "./marketCrash.js";
import { ROUNDS_WINDOW_MIN, buyMarketRoundsReason, roundsReason } from "./routeRounds.js";
import { formatTraderStates, summarizeTraderStates } from "./traderStates.js";
import { PRICE_IMPACT_PER_LOT, REFERENCE_TRIP_SECONDS, effectiveMarginFloor } from "./routeEconomics.js";
import { RouteBlocks, DEFAULT_BLOCK_POLICY } from "./routeBlocks.js";
import { learnImpact, type ImpactPolicy, type Learned } from "./lotImpact.js";
import { routeOutsideReach, systemOfWaypoint, type ShipReach } from "./shipReach.js";
import { bestFollowOn, chainScore, explainChain, DEFAULT_CHAIN_POLICY, type ChainCandidate, type ChainPolicy, type FollowOn } from "./chain.js";
import { DEFAULT_MATCH_POLICY, matchShips, type MatchPolicy } from "./matching.js";
import { bestCircuit, circuitExpired, circuitReport, circuitScore, judgeLeg2, legId, DEFAULT_CIRCUIT_POLICY, type Circuit, type CircuitPolicy, type PlannedCircuit } from "./circuit.js";
import { goodOfKey, type DispatchExplainSnapshot, type ExplainRejection, type ExplainRoute, type ExplainTrader } from "./dispatchExplain.js";

/** How far circuits have got since the process started, and why the rest were dropped (reason text with numbers masked as N). */
export interface CircuitCounts { planned: number; leg1Sold: number; leg2Served: number; leg2Loaded: number; completed: number; dropped: Record<string, number> }

/** Caps on what one recompute keeps for dispatch_explain, so the snapshot stays a few KB. */
export const EXPLAIN_MAX_ROUTES = 60;
export const EXPLAIN_MAX_REJECTIONS = 60;

/** A work item as dispatch_explain shows it. `profitPerTrip` is the ranking score; `rawProfit` the route's own figure when it differs. */
function explainRouteOf(
  w: { key: string; good?: string; buyAt?: string; sellAt?: string; buySystem?: string; profitPerTrip: number; rawProfit?: number },
  claimedBy: string | undefined,
): ExplainRoute {
  return {
    key: w.key,
    good: w.good ?? goodOfKey(w.key),
    buyAt: w.buyAt,
    sellAt: w.sellAt,
    buySystem: w.buySystem,
    profitPerTrip: Math.round(w.rawProfit ?? w.profitPerTrip),
    score: Math.round(w.profitPerTrip),
    claimedBy,
  };
}

/**
 * "direct"      — buy here, carry it yourself, sell there. One trader owns
 *                 the whole round trip; this is every assignment before
 *                 warehousing.
 * "buy"         — buy here, deposit into the warehouse. No sell leg of its
 *                 own.
 * "sell"        — withdraw from the warehouse, sell there. No buy leg of
 *                 its own.
 * "haul"        — withdraw from the warehouse, deliver to a mission/
 *                 construction site instead of a market. Not produced yet
 *                 (tracer 6).
 * "contractBuy" — buy here, then just hold it. No warehouse leg, no sell
 *                 leg: TraderAgent's own deliverCargo check (run before role
 *                 dispatch, same as ShipAgent's) notices the ship is now
 *                 carrying a contract-deliverable good and routes it to the
 *                 contract's destination on a later tick — this assignment
 *                 only needs to get the good INTO the hold.
 */
export type TraderRole = "direct" | "buy" | "sell" | "haul" | "contractBuy";

/** Most ships that may buy one contract good at once (slots 1..N), when enough ships are pinned to contract duty. */
export const MAX_CONTRACT_SLOTS = 4;
/** Work key of the k-th parallel buyer of a contract good: slot 1 keeps the plain `GOOD:contractBuy` key. */
export const contractSlotKey = (good: string, slot: number): string => (slot <= 1 ? `${good}:contractBuy` : `${good}:contractBuy#${slot}`);
/** 0 for any work key that is not a contract buy, else its slot number. */
export const contractSlotOf = (key: string): number => {
  const m = /:contractBuy(?:#(\d+))?$/.exec(key);
  return m ? Number(m[1] ?? 1) : 0;
};

export interface TraderAssignment {
  shipSymbol: string;
  good: string;
  role: TraderRole;
  /** Populated for "direct"/"buy"/"haul"; absent for a pure "sell". */
  buyAt?: string;
  /** Populated for "direct"/"sell"/"haul"; absent for a pure "buy". */
  sellAt?: string;
  buyPrice?: number;
  sellPrice?: number;
  profitPerTrip: number;
  /** "auto" (allocated) or "manual" (operator override). */
  source: "auto" | "manual";
  /** Credits per unit the operator is willing to lose on a manual route. null = default margin gate. */
  maxLossPerUnit?: number | null;
  /** True only for a "buy" assignment sourced to feed an active mission's
   *  outstanding demand — exempts it from the trader's protectedGoods
   *  block, which otherwise refuses to buy a mission-reserved good. */
  missionBuy?: boolean;
  /** Informational: the route the dispatcher expected this trip to lead into (see chain.ts). The trader does not read it. */
  followOn?: { good: string; buyAt: string; sellAt: string; score: number };
  /** Informational: this trip is one leg of a two-leg circuit (see circuit.ts). Leg 1 names the leg planned to follow;
   *  leg 2 is that leg being served. The trader does not read it; the dispatcher keeps the second leg for this ship. */
  circuit?: { leg: 1 | 2; leg2: { good: string; buyAt: string; sellAt: string; score: number }; explain: string };
  /** A "contractBuy" only: which of the parallel buyers for this good it is (1 = the first; 2+ exist only for ships on contract duty). */
  slot?: number;
}

/** A good's warehouse state, as input to deciding whether it needs a buy or
 *  sell trader this cycle. Supplied by the caller (fleet.ts) — the
 *  dispatcher doesn't read the store directly. */
export interface WarehouseTarget {
  good: string;
  /** Desired units to hold. */
  target: number;
  /** Units currently held. */
  balance: number;
}

/** A mission material the warehouse already holds stock of, as input to
 *  deciding whether it needs a haul trader this cycle. Supplied by the
 *  caller (fleet.ts), which cross-references MissionManager's outstanding
 *  requirements against the warehouse balance — the dispatcher only sees
 *  the result, not either source directly. */
export interface HaulTarget {
  good: string;
  /** The construction site waiting on this material. */
  targetWaypoint: string;
  /** Units the mission still needs. */
  needed: number;
  /** Units currently held in the warehouse. */
  balance: number;
}

/** A good flagged "buy for mission" on the curated warehouse list, with an
 *  active mission currently short of it. Unlike WarehouseTarget this isn't
 *  driven by a flat operator-set target — the target IS the mission's
 *  outstanding need, and there's usually no profitable resale route to
 *  derive buyAt/buyPrice from, so the caller (fleet.ts) sources them from
 *  the cheapest known market instead. */
export interface MissionBuyTarget {
  good: string;
  buyAt: string;
  buyPrice: number;
  /** Units the mission still needs. */
  needed: number;
  /** Units currently held in the warehouse. */
  balance: number;
}

/** A good an accepted contract still needs delivered, sourced from the
 *  cheapest known market — the contract equivalent of MissionBuyTarget,
 *  minus the warehouse balance (a "contractBuy" assignment never touches
 *  the warehouse; see TraderRole's own comment). Supplied by the caller
 *  (fleet.ts), which cross-references ContractManager's outstanding
 *  deliveries against the cheapest known market for each good. */
export interface ContractBuyTarget {
  good: string;
  buyAt: string;
  buyPrice: number;
  /** Units still outstanding across every contract that needs this good. */
  needed: number;
  /**
   * Total onFulfilled payout still reachable by finishing off the
   * contract(s) that need this good — a contract pays out as one lump sum
   * on completion, not per unit, so a 4-unit shortfall on an otherwise-done
   * contract is worth exactly as much as it was at 64 units. Optional and
   * falls back to the old needed-based estimate when the caller can't
   * supply it (e.g. existing tests): see the priority computation below.
   */
  value?: number;
}

/**
 * Centralized route dispatcher. The fleet's traders previously each picked their
 * own best route independently, which meant several traders could converge on
 * the same good (and saturate a single market, driving prices up and margins
 * down). This dispatcher computes every profitable route once and hands each
 * trader a DISTINCT assignment, so no two traders run the same good at once.
 *
 * The operator can override any trader's assignment from the UI; manual
 * overrides are respected until the operator clears them.
 *
 * This is deliberately the coordinator for warehousing later: once we hold
 * inventory, the dispatcher is where we decide "who hauls what, from where".
 */
/**
 * How long a just-sold (good, sellAt) pair is deprioritized before it can
 * win "best route for this good" again. Not a hard block — a route on
 * cooldown still gets picked if it's the only one available for its good,
 * rather than leaving a trader idle — just sorted behind every route that
 * isn't. Long enough that a market has genuinely had a chance to move
 * (SpaceTraders prices recover over real time, not instantly), short
 * enough that a route that's actually still the best one available isn't
 * needlessly starved.
 *
 * Superseded by the volume-decay scoring below (see recordSale()'s own
 * comment): a flat cooldown only reacts *after* a route has already been
 * sold into once, which stopped one immediate re-sale but did nothing
 * about a whole fleet converging on the same handful of markets over a
 * burst of trading — confirmed live, THEO's fleet ran up 3.6M credits in
 * ~30 minutes system-wide and every route in the system went to zero at
 * once, well before any single route's 10-minute cooldown would have
 * fired. Kept only as the window length for the decay below.
 */
const VOLUME_WINDOW_MS = 30 * 60_000;
/** How long a sale's price is kept for the sell-market recovery model; the longest recovery setting is 240 minutes. */
const SALE_IMPACT_KEEP_MS = 4 * 3_600_000;

export class RouteDispatcher {
  private assignments = new Map<string, TraderAssignment>();
  private manual = new Map<string, TraderAssignment>();
  /** Auto "direct" trips a trader is committed to until the delivery is done.
   *  `hadCargo` flips once the hold has been seen loaded, so an empty hold
   *  afterwards means the sale completed. */
  private committed = new Map<string, { at: number; hadCargo: boolean }>();
  /** Auto legs a trader refused (see decline()), kept out of that trader's picks until `until`. */
  private declined = new Map<string, { good: string; buyAt?: string; sellAt?: string; wholeGood: boolean; until: number }>();
  /** Circuits handed out (leg 1 assigned) whose second leg is kept for that ship until it is served or the plan expires.
   *  Saved by the caller via circuitSnapshot() and loaded with restoreCircuits(); without that a restart forgets them and
   *  every trader simply picks fresh work, as before circuits existed. */
  private circuits = new Map<string, PlannedCircuit>();
  /** Why a planned circuit was forgotten outside recompute (release, decline, manual route), logged by the next recompute. */
  private circuitNotes: string[] = [];
  /** How far each planned circuit has got, with timestamps, for the lifecycle log (in memory: a restart starts it afresh). */
  private circuitRun = new Map<string, { plannedAt: number; leg1: string; leg2: string; leg1SoldAt?: number; leg2ServedAt?: number; leg2LoadedAt?: number }>();
  /** Counters over every circuit since the process started: how many got how far, and why the rest were dropped. */
  private circuitCounts: CircuitCounts = { planned: 0, leg1Sold: 0, leg2Served: 0, leg2Loaded: 0, completed: 0, dropped: {} };
  /** The last circuit events, newest last, each stamped; the log buffer is shared with everything else and rolls over fast. */
  private circuitHistory: { at: number; ship: string; event: string; text: string }[] = [];
  /** Record one circuit event: into the history, and (when `log` is given) the log. `drop` names a reason to count. */
  private circuitEvent(ship: string, event: string, text: string, nowMs: number, log?: (m: string) => void, drop?: string): void {
    if (drop !== undefined) {
      const key = drop.replace(/\d+/g, "N");
      this.circuitCounts.dropped[key] = (this.circuitCounts.dropped[key] ?? 0) + 1;
    }
    this.circuitHistory.push({ at: nowMs, ship, event, text });
    if (this.circuitHistory.length > 120) this.circuitHistory.splice(0, this.circuitHistory.length - 120);
    log?.(`dispatch circuit: ${ship} ${text}`);
  }
  /** Circuit lifecycle: counters, recent events and the circuits still open, for the ops tool and for checking whether second legs ever run. */
  circuitLog(): { counts: CircuitCounts; open: { ship: string; leg1: string; leg2: string; plannedMinAgo: number; leg1SoldMinAgo: number | null; leg2ServedMinAgo: number | null }[]; events: { at: number; ship: string; event: string; text: string }[] } {
    const now = Date.now();
    const ago = (t: number | undefined) => (t === undefined ? null : Math.round((now - t) / 600) / 100);
    return {
      counts: { ...this.circuitCounts, dropped: { ...this.circuitCounts.dropped } },
      open: [...this.circuitRun.entries()].map(([ship, r]) => ({ ship, leg1: r.leg1, leg2: r.leg2, plannedMinAgo: Math.round((now - r.plannedAt) / 600) / 100, leg1SoldMinAgo: ago(r.leg1SoldAt), leg2ServedMinAgo: ago(r.leg2ServedAt) })),
      events: [...this.circuitHistory],
    };
  }
  /** Leg 1's cargo has been sold: leg 2 may now be served. Counted and logged once per circuit. */
  private markLeg1Sold(ship: string, planned: PlannedCircuit, nowMs: number, log?: (m: string) => void): void {
    if (planned.leg1Sold) return;
    planned.leg1Sold = true;
    const run = this.circuitRun.get(ship);
    if (run) run.leg1SoldAt = nowMs;
    this.circuitCounts.leg1Sold += 1;
    const after = run ? ` ${Math.round((nowMs - run.plannedAt) / 1000)}s after it was planned` : "";
    this.circuitEvent(ship, "leg1_sold", `leg 1 sold${after}; leg 2 ${legId(planned.leg2)} is now eligible`, nowMs, log);
  }
  /** The last serialized circuits handed to / loaded by the persistence layer, to tell when they changed. */
  private savedCircuits = "[]";
  /** The ranked route list from the last recompute, used to serve live claims. */
  private routes: DispatchRoute[] = [];
  private lastComputed = 0;
  /** What the last non-throttled recompute saw and decided, for dispatch_explain. Replaced wholesale each cycle. */
  private lastExplain: DispatchExplainSnapshot | undefined;
  /** (good, sellAt) → recent real sales into that market, each as the units
   *  moved and when. Confirmed live twice: THEO-1 sold 40u ELECTRONICS at
   *  X1-XB94-D43 for 35,900c; the very next idle trader (THEO-A) was handed
   *  the identical "best" route 8 minutes later and got 20,800c for the
   *  same 40 units. Then, after a flat per-route cooldown closed that
   *  specific hole, the fleet ran up 3.6M credits system-wide in ~30
   *  minutes and every route in the system went to zero profit at once —
   *  a cooldown only reacts after a route is sold into once; it does
   *  nothing about a burst spread across many routes that individually
   *  never triggered it. See recordSale() and scoreRoute(). */
  private readonly recentSales = new Map<string, { units: number; at: number }[]>();

  /** Called by a trader right after a real sell transaction completes, so
   *  the next recompute can weigh how much the fleet has already sold into
   *  this exact market recently — see scoreRoute(). */
  recordSale(good: string, sellAt: string, units: number, pricePerUnit?: number): void {
    const key = `${good}@${sellAt}`;
    const list = this.recentSales.get(key) ?? [];
    list.push({ units, at: Date.now() });
    this.recentSales.set(key, list);
    // Prices kept apart from the volume list: that one is pruned at 30 minutes, a market takes longer to refill (marketCrash.ts).
    if (pricePerUnit !== undefined && pricePerUnit > 0) {
      const now = Date.now();
      const impacts = (this.saleImpacts.get(key) ?? []).filter((s) => s.at >= now - SALE_IMPACT_KEEP_MS).slice(-200);
      impacts.push({ units, at: now, price: pricePerUnit });
      this.saleImpacts.set(key, impacts);
    }
  }

  /** (good, sellAt) -> our recent lots with the price each fetched, kept long enough to model a market refilling. */
  private readonly saleImpacts = new Map<string, SaleImpact[]>();
  /** (good, buyAt) -> our recent purchase lots with the price each cost, for the same model on the buy side. */
  private readonly buyImpacts = new Map<string, SaleImpact[]>();

  /** Called by a trader after each purchase lot of a route (the ask our own buying leaves behind, see marketCrash.ts). */
  recordBuy(good: string, buyAt: string, units: number, pricePerUnit: number): void {
    if (!(pricePerUnit > 0)) return;
    const key = `${good}@${buyAt}`;
    const now = Date.now();
    const impacts = (this.buyImpacts.get(key) ?? []).filter((s) => s.at >= now - SALE_IMPACT_KEEP_MS).slice(-200);
    impacts.push({ units, at: now, price: pricePerUnit });
    this.buyImpacts.set(key, impacts);
  }
  private marketRecoveryMin = 0;

  private savedImpactsAt = 0;
  private savedImpacts = '{"sales":[],"buys":[]}';
  /**
   * Our recent sale and purchase lots per market, as JSON, for saving across a restart. They are what the sell and buy
   * recovery pricing (marketCrash.ts) and the learned price impact (lotImpact.ts) are built from; held only in memory,
   * every deploy made the dispatcher forget the markets it had just dumped into and plan on the stale snapshot price
   * again until a ship next visited. Returns undefined when nothing has changed or the last write was under `minIntervalMs`
   * ago (lots arrive every few seconds across the fleet; one flag write a minute is plenty). Only lots inside the keep
   * window and the last 60 per market are written.
   */
  impactsSnapshot(now: number = Date.now(), minIntervalMs = 60_000): string | undefined {
    if (now - this.savedImpactsAt < minIntervalMs) return undefined;
    const pack = (m: Map<string, SaleImpact[]>) =>
      [...m.entries()]
        .map(([key, lots]) => [key, lots.filter((l) => l.at >= now - SALE_IMPACT_KEEP_MS).slice(-60).map((l) => [l.units, l.at, l.price])] as const)
        .filter(([, lots]) => lots.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const json = JSON.stringify({ sales: pack(this.saleImpacts), buys: pack(this.buyImpacts) });
    this.savedImpactsAt = now;
    if (json === this.savedImpacts) return undefined;
    this.savedImpacts = json;
    return json;
  }
  /** Load lots saved by impactsSnapshot(); lots outside the keep window and malformed rows are skipped. Returns how many were loaded. */
  restoreImpacts(json: string, now: number = Date.now()): number {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return 0; }
    if (!parsed || typeof parsed !== "object") return 0;
    let loaded = 0;
    const load = (rows: unknown, into: Map<string, SaleImpact[]>) => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== "string" || !Array.isArray(row[1])) continue;
        const lots: SaleImpact[] = [];
        for (const l of row[1]) {
          if (!Array.isArray(l)) continue;
          const [units, at, price] = l as unknown[];
          if (typeof units !== "number" || typeof at !== "number" || typeof price !== "number" || !(units > 0) || !(price > 0) || at < now - SALE_IMPACT_KEEP_MS) continue;
          lots.push({ units, at, price });
        }
        if (lots.length === 0) continue;
        // keep anything recorded since this process started, in time order
        into.set(row[0], [...lots, ...(into.get(row[0]) ?? [])].sort((a, b) => a.at - b.at).slice(-200));
        loaded += lots.length;
      }
    };
    const o = parsed as { sales?: unknown; buys?: unknown };
    load(o.sales, this.saleImpacts);
    load(o.buys, this.buyImpacts);
    this.savedImpacts = "";
    this.savedImpactsAt = 0;
    return loaded;
  }

  /** Routes any ship has found dead on arrival, shared so the next ship is not sent to the same one (routeBlocks.ts). */
  private readonly routeBlocks = new RouteBlocks();
  private routeBlockMin = 0;
  /** A ship reports a route dead: a buy market whose live price no longer pays (no `sellAt`), or one destination that refused. */
  reportDeadRoute(good: string, buyAt: string, sellAt: string | undefined, reason: string): void {
    this.routeBlocks.report(good, buyAt, sellAt, reason, Date.now(), { ...DEFAULT_BLOCK_POLICY, ttlMin: this.routeBlockMin });
  }
  private savedDeadRoutes = "[]";
  /** The standing dead-route blocks as JSON, once, when they have changed since the last call (undefined otherwise), so the
   *  caller can save them across a restart. An empty list is "[]". */
  deadRoutesSnapshot(): string | undefined {
    const json = this.routeBlocks.toJson(Date.now());
    if (json === this.savedDeadRoutes) return undefined;
    this.savedDeadRoutes = json;
    return json;
  }
  /** Load blocks saved by deadRoutesSnapshot(); returns how many were still standing. */
  restoreDeadRoutes(json: string): number {
    const n = this.routeBlocks.restore(json, Date.now());
    this.savedDeadRoutes = this.routeBlocks.toJson(Date.now());
    return n;
  }
  /** Why a route is held back as dead, or undefined (always undefined with the clause off). A trader already on its way asks
   *  this so it re-plans as soon as another ship has found the route dead, instead of flying there to find out itself. */
  deadRouteReason(good: string, buyAt: string, sellAt: string): string | undefined {
    if (!(this.routeBlockMin > 0)) return undefined;
    return this.routeBlocks.reasonFor({ good, buyAt, sellAt }, Date.now());
  }
  private gatedSystems: ReadonlySet<string> = new Set();
  /** The systems whose routes are held back behind the fresh-system gate; takes effect at the next recompute. */
  setGatedSystems(systems: ReadonlySet<string>): void {
    this.gatedSystems = systems;
  }
  gatedSystemList(): string[] {
    return [...this.gatedSystems];
  }
  /** The routes held back now, for the ops view. */
  deadRouteList(): ReturnType<RouteBlocks["list"]> {
    return this.routeBlocks.list(Date.now());
  }

  /**
   * How many of the routes held now buy or sell at each market, and how many are held back as dead (a dead-route key is
   * "good@buyAt" or "good@buyAt>sellAt", so it touches the buy market and, for a pair, the destination). Keeper triage reads
   * this: a market no viable route touches is one whose keeper is polling for nothing.
   */
  marketRouteUse(): Map<string, { viable: number; dead: number }> {
    const use = new Map<string, { viable: number; dead: number }>();
    const at = (m: string) => {
      let u = use.get(m);
      if (!u) { u = { viable: 0, dead: 0 }; use.set(m, u); }
      return u;
    };
    for (const r of this.routes) {
      at(r.buyAt).viable++;
      if (r.sellAt !== r.buyAt) at(r.sellAt).viable++;
    }
    for (const d of this.routeBlocks.list(Date.now())) {
      const m = d.key.split("@")[1];
      if (!m) continue;
      const [buy, sell] = m.split(">");
      if (buy) at(buy).dead++;
      if (sell) at(sell).dead++;
    }
    return use;
  }

  /** What a lot of ours moves the price at this (good, market) on this side: the flat default, or what our own recent
   *  runs there measured when the policy is on (lotImpact.ts). */
  impactFor(side: "buy" | "sell", good: string, at: string, tradeVolume: number, policy: ImpactPolicy): Learned {
    const lots = (side === "buy" ? this.buyImpacts : this.saleImpacts).get(`${good}@${at}`) ?? [];
    return learnImpact(side, lots, Date.now(), PRICE_IMPACT_PER_LOT, policy, tradeVolume);
  }

  /** The route with its sell price, profit and per-hold profits cut by the part of our own recent dump that has not
   *  refilled (marketCrash.ts), or undefined when the trip no longer pays. With `marketRecoveryMin` 0 it is the route as given. */
  private afterOwnSales(route: DispatchRoute, now: number): { route: DispatchRoute; reason?: string } | undefined {
    if (!(this.marketRecoveryMin > 0)) return { route };
    const policy = { recoveryMin: this.marketRecoveryMin };
    const snapshotAt = now - route.ageMinutes * 60_000;
    const sales = this.saleImpacts.get(`${route.good}@${route.sellAt}`);
    const buys = this.buyImpacts.get(`${route.good}@${route.buyAt}`);
    const sell = sales?.length ? estimateSellPrice(sales, route.sellPrice, snapshotAt, now, policy) : undefined;
    const buy = buys?.length ? estimateBuyPrice(buys, route.buyPrice, snapshotAt, now, policy) : undefined;
    const sellCut = sell?.shortfall ?? 0;
    const buyCut = buy?.shortfall ?? 0;
    if (sellCut <= 0 && buyCut <= 0) return { route };
    const perUnit = sellCut + buyCut;
    const profitPerTrip = profitAfterShortfall(route.profitPerTrip, perUnit, route.volume);
    if (profitPerTrip <= 0) return undefined;
    const profitByHold = route.profitByHold
      ? Object.fromEntries(Object.entries(route.profitByHold).map(([hold, p]) => [hold, profitAfterShortfall(p, perUnit, Number(hold))]))
      : undefined;
    const adjusted: DispatchRoute = {
      ...route,
      sellPrice: sell?.shortfall ? sell.price : route.sellPrice,
      buyPrice: buy?.shortfall ? buy.price : route.buyPrice,
      profitPerTrip,
      ...(profitByHold ? { profitByHold } : {}),
    };
    const reason = [sell?.shortfall ? `sell: ${sell.reason}` : "", buy?.shortfall ? `buy: ${buy.reason}` : ""].filter(Boolean).join("; ");
    return { route: adjusted, reason };
  }


  /** Closed trips, newest last, for the route cool-off (routeHeat.ts). Only the last few hours matter. */
  private readonly closedTrips: RouteTrip[] = [];

  /** Called by a trader when a trip closes, with what it promised and what it made. */
  recordTrip(t: { good: string; buyAt: string; sellAt: string; promised: number; made: number }): void {
    const now = Date.now();
    this.closedTrips.push({ ...t, at: now });
    while (this.closedTrips.length && (this.closedTrips.length > 200 || this.closedTrips[0]!.at < now - 6 * 3_600_000)) this.closedTrips.shift();
  }

  /** Why this exact route is resting after a disappointing trip or too many trips on it, or undefined. `minutes` 0 = off
   *  for the cool-off; the round limit is read from `roundsMax`, so the two clauses switch on independently. */
  routeCoolOff(good: string, buyAt: string, sellAt: string, minutes = this.coolOffMin): string | undefined {
    return coolOffReason(this.closedTrips, good, buyAt, sellAt, Date.now(), { ...DEFAULT_HEAT_POLICY, minutes }) ??
      roundsReason(this.closedTrips, good, buyAt, sellAt, Date.now(), { maxRounds: this.roundsMax, windowMin: ROUNDS_WINDOW_MIN }) ??
      buyMarketRoundsReason(this.closedTrips, good, buyAt, Date.now(), { maxRounds: this.buyRoundsMax, windowMin: ROUNDS_WINDOW_MIN });
  }
  private coolOffMin = 0;
  /** Where recompute notes go. console.log by default; the fleet points it at its own log so they reach the ops `logs` tool. */
  private logger: (msg: string) => void = (m) => console.log(m);
  setLogger(fn: (msg: string) => void): void { this.logger = fn; }
  private roundsMax = 0;
  private buyRoundsMax = 0;

  /** Units sold into this (good, sellAt) market within the recent window.
   *  Prunes anything older as a side effect, so a market's fatigue fades
   *  away on its own as the window ages sales out, rather than snapping
   *  back all at once the way a flat cooldown's expiry did. */
  private recentVolume(good: string, sellAt: string): number {
    const key = `${good}@${sellAt}`;
    const list = this.recentSales.get(key);
    if (!list) return 0;
    const cutoff = Date.now() - VOLUME_WINDOW_MS;
    const fresh = list.filter((s) => s.at >= cutoff);
    if (fresh.length !== list.length) {
      if (fresh.length) this.recentSales.set(key, fresh);
      else this.recentSales.delete(key);
    }
    return fresh.reduce((sum, s) => sum + s.units, 0);
  }

  /** A route's ranking score: its real profitPerTrip, discounted by how
   *  much volume the fleet has already dumped into this exact market
   *  recently, relative to the route's own trip size. Selling roughly one
   *  trip's worth of extra volume into a market halves its score, two
   *  trips' worth thirds it, and so on — a graduated version of the old
   *  binary cooldown that lets the dispatcher spread trades across markets
   *  *before* a price actually craters, not just react once it has.
   *  `route.profitPerTrip` itself is left untouched — this only changes
   *  ranking order, not the number shown on the dashboard or handed to
   *  toAssignment(). */
  private scoreRoute(route: DispatchRoute): number {
    // Profit per trip, scaled to a reference trip length when the route knows its round-trip time, so a
    // short repeating route outranks a long one earning the same per trip.
    const base = route.tripSeconds ? (route.profitPerTrip * REFERENCE_TRIP_SECONDS) / route.tripSeconds : route.profitPerTrip;
    const sold = this.recentVolume(route.good, route.sellAt);
    if (sold <= 0) return base;
    return base / (1 + sold / Math.max(route.volume, 1));
  }

  /** The last cycle's work list and per-trader rejection reasons (see dispatchExplain.ts). Undefined before the first recompute. */
  explain(): DispatchExplainSnapshot | undefined {
    return this.lastExplain;
  }

  /** Routes a single trader should fly, honoring a manual override if set. */
  assignmentFor(shipSymbol: string): TraderAssignment | undefined {
    return this.manual.get(shipSymbol) ?? this.assignments.get(shipSymbol);
  }

  /** Why a (good, sell market) pair is not open to a new trader right now, or undefined when it is. The dispatcher hands
   *  out one trader per good per sell market, and keeps a second circuit leg for the ship that planned it, so a route
   *  into a market already in use is blocked whatever its buy market is. */
  sellMarketBlock(good: string, sellAt: string): string | undefined {
    for (const a of this.list()) {
      if (a.good === good && a.sellAt === sellAt) return `${sellAt} is taken by ${a.shipSymbol}`;
    }
    for (const [ship, planned] of this.circuits) {
      if (planned.leg2.good === good && planned.leg2.sellAt === sellAt) return `${sellAt} is held for ${ship}'s circuit`;
    }
    return undefined;
  }

  list(): TraderAssignment[] {
    const ships = new Set([...this.assignments.keys(), ...this.manual.keys()]);
    const out: TraderAssignment[] = [];
    for (const s of ships) {
      const a = this.manual.get(s) ?? this.assignments.get(s);
      if (a) out.push(a);
    }
    return out;
  }

  /** Assign a specific route to a trader. Pass undefined to clear an override. */
  setManual(shipSymbol: string, assignment: TraderAssignment | undefined): void {
    this.committed.delete(shipSymbol);
    this.forgetCircuit(shipSymbol, "a manual route was set or cleared");
    if (assignment) {
      this.manual.set(shipSymbol, { ...assignment, source: "manual" });
    } else {
      this.manual.delete(shipSymbol);
      // recompute() copies a manual override into `assignments`, so without
      // this the released route lingers there (and busy-trader carry-forward
      // keeps handing it back) until the ship goes idle. Confirmed live
      // 2026-10-02, THEO-8: "Release to auto" cleared the stored flag but the
      // dispatcher kept logging its old manual ANTIMATTER route as assigned.
      if (this.assignments.get(shipSymbol)?.source === "manual") this.assignments.delete(shipSymbol);
    }
  }

  /** The empty commitments JSON counts as already saved, so a dispatcher with nothing in flight has nothing to write. */
  private savedCommitments: string | undefined = EMPTY_COMMITMENTS;

  /** Planned circuits as JSON, once, when they have changed since the last call (undefined otherwise), so the caller can
   *  persist them across a restart. An empty plan list is "[]". */
  circuitSnapshot(): string | undefined {
    const json = JSON.stringify([...this.circuits.entries()]);
    if (json === this.savedCircuits) return undefined;
    this.savedCircuits = json;
    return json;
  }

  /** Each auto direct trip and its commitment as JSON, once, when they have changed since the last call (undefined
   *  otherwise). Without this a restart forgets who is flying where: an empty trader already on its way to the buy market
   *  looks idle and is handed the best route again, mid-flight. */
  commitmentsSnapshot(): string | undefined {
    const trips = [...this.assignments.entries()].filter(([, a]) => a.source === "auto" && a.role === "direct");
    const json = JSON.stringify({ trips, committed: [...this.committed.entries()] });
    if (json === this.savedCommitments) return undefined;
    this.savedCommitments = json;
    return json;
  }

  /** Load commitments saved by commitmentsSnapshot(). Malformed rows are skipped; a commitment whose trader is not
   *  flying a trip is dropped by the next recompute, as it always was. */
  restoreCommitments(json: string): void {
    try {
      const data = JSON.parse(json) as { trips?: unknown; committed?: unknown };
      for (const row of Array.isArray(data.trips) ? data.trips : []) {
        const [ship, a] = row as [unknown, TraderAssignment | undefined];
        if (typeof ship !== "string" || !a || typeof a.good !== "string" || a.role !== "direct") continue;
        this.assignments.set(ship, a);
      }
      for (const row of Array.isArray(data.committed) ? data.committed : []) {
        const [ship, c] = row as [unknown, { at?: unknown; hadCargo?: unknown } | undefined];
        if (typeof ship !== "string" || !c || typeof c.at !== "number") continue;
        this.committed.set(ship, { at: c.at, hadCargo: c.hadCargo === true });
      }
    } catch {
      // unreadable: start empty, as before commitments were saved
    }
  }

  /** Load circuits saved by circuitSnapshot(). Anything malformed is skipped; an expired plan is dropped on the next recompute. */
  restoreCircuits(json: string): void {
    try {
      const rows = JSON.parse(json) as unknown;
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const [ship, p] = row as [unknown, PlannedCircuit | undefined];
        if (typeof ship !== "string" || !p || typeof p.at !== "number" || typeof p.leg2Score !== "number") continue;
        const l = p.leg2;
        if (!l || typeof l.good !== "string" || typeof l.buyAt !== "string" || typeof l.sellAt !== "string") continue;
        this.circuits.set(ship, { leg2: { good: l.good, buyAt: l.buyAt, sellAt: l.sellAt }, leg2Score: p.leg2Score, at: p.at, ...(p.leg1Sold ? { leg1Sold: true } : {}) });
      }
    } catch {
      // unreadable: start with whatever parsed, which is nothing
    } finally {
      this.savedCircuits = JSON.stringify([...this.circuits.entries()]);
    }
  }

  isManual(shipSymbol: string): boolean {
    return this.manual.has(shipSymbol);
  }

  /** The ranked routes the dispatcher is currently allocating from. */
  routeList(): DispatchRoute[] {
    return this.routes;
  }

  private toAssignment(shipSymbol: string, route: DispatchRoute): TraderAssignment {
    return {
      shipSymbol,
      good: route.good,
      role: "direct",
      buyAt: route.buyAt,
      sellAt: route.sellAt,
      buyPrice: route.buyPrice,
      sellPrice: route.sellPrice,
      profitPerTrip: route.profitPerTrip,
      source: "auto",
    };
  }

  /** `route` only needs to look like a buy leg — a full DispatchRoute
   *  qualifies, but so does a synthetic one built from the cheapest known
   *  market for a mission-buy good that has no profitable resale route at all. */
  private toBuyAssignment(
    shipSymbol: string,
    route: { good: string; buyAt: string; buyPrice: number; profitPerTrip: number },
    missionBuy = false,
  ): TraderAssignment {
    return {
      shipSymbol,
      good: route.good,
      role: "buy",
      buyAt: route.buyAt,
      buyPrice: route.buyPrice,
      profitPerTrip: route.profitPerTrip,
      source: "auto",
      ...(missionBuy ? { missionBuy: true } : {}),
    };
  }

  private toSellAssignment(shipSymbol: string, route: DispatchRoute): TraderAssignment {
    return {
      shipSymbol,
      good: route.good,
      role: "sell",
      sellAt: route.sellAt,
      sellPrice: route.sellPrice,
      profitPerTrip: route.profitPerTrip,
      source: "auto",
    };
  }

  /** No sell/warehouse leg at all — see TraderRole's own comment on why. */
  private toContractBuyAssignment(shipSymbol: string, target: ContractBuyTarget, priority: number, slot = 1): TraderAssignment {
    return {
      shipSymbol,
      good: target.good,
      role: "contractBuy",
      slot,
      buyAt: target.buyAt,
      buyPrice: target.buyPrice,
      profitPerTrip: priority,
      source: "auto",
    };
  }

  /** `sellAt` is repurposed as "delivery destination" for a haul assignment —
   *  a construction site rather than a market — so TraderAgent's rendezvous
   *  step (fly to warehouse, withdraw, fly to `sellAt`) needs no role-specific
   *  field of its own. */
  private toHaulAssignment(shipSymbol: string, good: string, targetWaypoint: string, priority: number): TraderAssignment {
    return {
      shipSymbol,
      good,
      role: "haul",
      sellAt: targetWaypoint,
      profitPerTrip: priority,
      source: "auto",
    };
  }

  /** Goods spoken for by someone other than `shipSymbol`. */
  private takenGoods(shipSymbol?: string): Set<string> {
    const taken = new Set<string>();
    for (const [s, a] of this.assignments) if (s !== shipSymbol) taken.add(a.good);
    for (const [s, a] of this.manual) if (s !== shipSymbol) taken.add(a.good);
    return taken;
  }

  /**
   * Take the best unclaimed route for a trader, right now.
   *
   * This is the fix for route convergence. Previously a trader whose assignment
   * was unviable fell back to picking its own best good from its own price
   * table, and the only thing stopping two traders from picking the same good
   * was a reservation set derived from cargo already in holds — a lagging
   * signal, so two traders inside their own `findRoute` at the same time could
   * (and did) both take the same good. Claiming goes through here instead:
   * the whole select-and-record is one synchronous call, so no other trader's
   * loop can interleave between "is it free?" and "it's mine".
   *
   * `accept` lets the caller reject a route it can't actually fly (unknown
   * market, no margin at its own prices) without giving up the claim attempt —
   * the next-best route is tried in the same synchronous pass.
   */
  claim(shipSymbol: string, accept?: (route: DispatchRoute) => boolean): TraderAssignment | undefined {
    const manual = this.manual.get(shipSymbol);
    if (manual) return manual;
    // A ship on contract duty takes contract work only; it must not pick its own arbitrage route here.
    if (this.contractDuty.has(shipSymbol)) return this.assignments.get(shipSymbol)?.role === "contractBuy" ? this.assignments.get(shipSymbol) : undefined;
    const taken = this.takenGoods(shipSymbol);
    const route = this.routes.find((r) => !taken.has(r.good) && (accept ? accept(r) : true));
    if (!route) {
      // Nothing left to fly: drop the stale assignment so the good is freed for
      // a fleetmate and this trader goes price-hunting instead.
      this.assignments.delete(shipSymbol);
      return undefined;
    }
    const assignment = this.toAssignment(shipSymbol, route);
    this.assignments.set(shipSymbol, assignment);
    return assignment;
  }

  /** Ships pinned to contract work: they are given contract-buy jobs (whichever contract needs a good next) and nothing else. */
  private readonly contractDuty = new Set<string>();

  /** Pin a trader to contract work, or put it back on ordinary trading. */
  setContractDuty(shipSymbol: string, on: boolean): void {
    if (!on) { this.contractDuty.delete(shipSymbol); return; }
    this.contractDuty.add(shipSymbol);
    const a = this.assignments.get(shipSymbol);
    if (a && a.role !== "contractBuy") this.assignments.delete(shipSymbol);
  }

  contractDutyShips(): string[] { return [...this.contractDuty].sort(); }

  /** Is this ship on contract work: pinned to contract duty, or holding a contract-buy assignment (auto or manual)? Feeds and
   *  missions must not take such a ship for their own crew. */
  onContractWork(shipSymbol: string): boolean {
    return this.contractDuty.has(shipSymbol) || this.assignments.get(shipSymbol)?.role === "contractBuy" || this.manual.get(shipSymbol)?.role === "contractBuy";
  }

  /** Give up a claim (ship scrapped, role changed, route abandoned). */
  release(shipSymbol: string): void {
    this.assignments.delete(shipSymbol);
    this.forgetCircuit(shipSymbol, "the ship was released");
  }

  private forgetCircuit(shipSymbol: string, why: string): void {
    const planned = this.circuits.get(shipSymbol);
    if (!planned) return;
    this.circuits.delete(shipSymbol);
    this.circuitRun.delete(shipSymbol);
    // Logged by the next recompute (this runs outside one), but counted and kept in the history now.
    this.circuitEvent(shipSymbol, "dropped", `dropped leg 2 ${legId(planned.leg2)} — ${why}`, Date.now(), undefined, why);
    this.circuitNotes.push(`dispatch circuit: ${shipSymbol} dropped leg 2 ${legId(planned.leg2)} — ${why}`);
  }

  /**
   * The trader refused its auto assignment (margin under the floor, a protected good, ...). Drop the assignment and
   * its commitment, and keep that leg out of this trader's picks for DECLINE_MS. Without this an empty trader stayed
   * committed to a leg it would never fly for up to COMMIT_GRACE_MS: confirmed live 2026-10-07, THEOREM_DEV_2-1
   * (FOOD K92 -> A1, margin 195-261c under a 300c floor) and THEOREM_DEV_2-3 (POLYNUCLEOTIDES, protected for a
   * contract) both flew price-discovery hops for 35+ minutes with CLOTHING worth 35,519c a trip unassigned.
   * `wholeGood` keeps every leg of that good out (a protected good is refused at any market, and 2-3 was handed
   * POLYNUCLEOTIDES E49 -> D46 right after refusing E49 -> F53).
   */
  decline(shipSymbol: string, wholeGood = false): void {
    const a = this.assignments.get(shipSymbol);
    if (!a || a.source === "manual") return;
    this.assignments.delete(shipSymbol);
    // The trader refuses what it still holds as its assignment, which right after a sale is the leg it just finished
    // (its price has moved), not the circuit's second leg. If cargo was seen aboard, leg 1 ran: keep the plan and mark it
    // sold, because the commitment that would have noticed the sale is deleted just below.
    const planned = this.circuits.get(shipSymbol);
    if (planned && !planned.leg1Sold) {
      if (this.committed.get(shipSymbol)?.hadCargo) this.markLeg1Sold(shipSymbol, planned, Date.now());
      else this.forgetCircuit(shipSymbol, "its first leg was refused before it ran");
    }
    this.committed.delete(shipSymbol);
    this.declined.set(shipSymbol, { good: a.good, buyAt: a.buyAt, sellAt: a.sellAt, wholeGood, until: Date.now() + DECLINE_MS });
  }

  /**
   * Recompute assignments from a ranked route list for the given traders.
   * Bigger holds get first pick. Manual overrides are preserved and reserve
   * their good in every role. Throttled to once/minute so the coordinator
   * doesn't churn assignments on every 2s tick.
   *
   * A trader that is `busy` — mid-haul, cargo in the hold — keeps the
   * assignment it is already flying, whatever its role. Reassigning it would
   * strand the cargo it bought for the old route, and the churn meant
   * assignments never settled.
   *
   * `warehouseTargets` is how a good gets split into buy/sell roles instead
   * of one trader running it end to end: pass a good's desired vs. current
   * warehouse balance and, once it's off-target, one trader gets sent to
   * buy into the warehouse (or sell out of it) instead of the direct round
   * trip. A good with no entry here — every good, until a caller actually
   * supplies targets — behaves exactly as before: one trader, direct route,
   * no two traders on the same good. This is what keeps tracer 2 inert: the
   * live coordinator doesn't pass targets yet, so nothing about today's
   * behavior changes until a future tracer wires real ones in.
   *
   * `haulTargets` is the same idea for mission supply: a good the warehouse
   * already holds stock of, that a construction site still needs, gets a
   * "haul" trader instead of sitting in the warehouse unused.
   *
   * `missionBuyTargets` closes the other half of mission supply: a good
   * flagged "buy for mission" with an active mission actually short of it
   * gets a "buy" trader sourced from the cheapest known market — the only
   * "buy" pathway allowed to acquire a good the trader's protectedGoods
   * would otherwise refuse (see TraderAssignment.missionBuy).
   *
   * `contractBuyTargets` is the same idea for accepted contracts: a good a
   * contract still needs delivered gets a "contractBuy" trader sourced from
   * the cheapest known market, same protectedGoods exemption as missionBuy.
   */
  recompute(
    routes: DispatchRoute[],
    traders: { shipSymbol: string; capacity: number; busy?: boolean; system?: string; waypoint?: string; fuelCapacity?: number; reach?: ShipReach }[],
    warehouseTargets: WarehouseTarget[] = [],
    haulTargets: HaulTarget[] = [],
    missionBuyTargets: MissionBuyTarget[] = [],
    contractBuyTargets: ContractBuyTarget[] = [],
    // Whether a jump between two systems is possible right now (gate known
    // and construction-complete). A plain predicate rather than an injected
    // GalaxyAtlas — this class otherwise has no galaxy dependency at all,
    // and the only place that needs an answer is the `direct` branch below
    // (buy/sell/haul don't: see computeDispatchRoutes()'s own comment on why
    // `routes` isn't pre-filtered by reachability). Defaults to same-system-
    // only, matching this class's pre-gate-check behavior, so a caller that
    // doesn't pass one gets the old, safe result rather than an error.
    canJump: (fromSystem: string, toSystem: string) => boolean = () => false,
    // Same-system fuel distance between two waypoints. Confirmed live:
    // without this, `reachable()` below only checked *system* membership,
    // so DRAGOM-3 was handed an AMMUNITION leg whose buy waypoint sat 99
    // units off with an 80-unit tank — same system, real route, un-flyable.
    // The trader's own whyNotViable() already rejects that leg, but only
    // after the assignment burned a cycle; this lets the dispatcher not
    // offer it in the first place. Optional and defaults to "always in
    // range" (0), same reasoning as canJump above — a caller that doesn't
    // pass one gets the old, distance-blind behavior rather than every
    // same-system route wrongly rejected.
    distanceBetween: (a: string, b: string) => number = () => 0,
    // Temporary diagnostic hook (docs: "why are idle traders not getting
    // assigned when profitable routes exist"). Logs, on every recompute that
    // actually runs (not throttled-skipped), the full work list this cycle
    // considered and the resulting good/ship pairing — cheap enough to leave
    // on, since it only fires once per 60s. Remove once the live question is
    // answered.
    log?: (msg: string) => void,
    // Whether a same-system relay through a known fuel stop closes a gap
    // `distanceBetween` alone says is too far — see reachable()'s own
    // comment for why this exists (2026-09-21) and trader.ts's matching
    // nextHopToward()/viableRoute() fix, which is what actually flies a leg
    // like this once assigned. Optional and defaults to "no relay known",
    // same reasoning every other optional param here uses — a caller that
    // doesn't pass one gets the old, single-hop-only behavior.
    hasFuelStop?: (system: string, from: string, to: string, capacity: number) => boolean,
    // Multi-hop cross-system assignment (phase 2 of the cross-system design).
    // Only consulted when `enabled`; otherwise every cross-system check below
    // is the long-standing single-hop `canJump` one. `path` returns the
    // systems crossed (both ends included, <= MAX_POSITIONING_HOPS jumps over
    // gates verified at both ends) or undefined; `hopCost` prices ONE jump.
    crossSystem?: {
      enabled: boolean;
      path: (from: string, to: string) => string[] | undefined;
      hopCost: (from: string, to: string) => number;
      /** The system whose traders the home reserve protects. */
      homeSystem?: string;
      /** Traders that must stay in the home system. */
      homeReserve?: number;
      /** The gate waypoint in `fromSystem` that leads to the adjacent `toSystem`, so the ship's own flight to it can be checked. */
      gateFor?: (fromSystem: string, toSystem: string) => string | undefined;
    },
    // Buyers-at-one-market handling (see BUY_IMPACT_PER_UNIT). All optional;
    // the defaults are the exported constants, and `marginFloor` (credits per
    // unit, the existing doctrine value) is the least predicted margin an extra
    // buyer at an already-chosen market must still clear.
    tuning?: { buyImpactPerUnit?: number; maxTradersPerBuyMarket?: number; marginFloor?: number; followOnWeight?: number; followOnHorizonMin?: number; circuitWeight?: number; circuitHorizonMin?: number; circuitCash?: number; circuitReturnShare?: number; circuitCrossSystem?: boolean; circuitMinGain?: number; circuitMinGainShare?: number; circuitMinLeg2Runs?: number; matchTopN?: number; jumpSeconds?: number; coolOffMin?: number; roundsMax?: number; buyRoundsMax?: number; marketRecoveryMin?: number; routeBlockMin?: number },
    // Legs traders are already flying with cargo aboard (from each agent's own
    // held-route pin), whether or not that ship is in `traders` — a hull
    // committed to a run drops out of the dispatcher's list, and after a
    // restart `assignments` is empty, so neither carry-forward nor the sell-
    // market check can see it. They still count against the per-market buyer
    // cap and reserve their sell market, so a good already on its way somewhere
    // is not handed to yet another trader.
    inFlight?: { shipSymbol: string; good: string; buyAt?: string; sellAt: string; units: number }[],
  ): void {
    const now = Date.now();
    // Unconditional throttle. This used to also require a non-empty assignment
    // map, which meant the one case that produces no assignments — no fresh
    // intel, so no routes — recomputed on every 2s tick, running a full
    // window-function scan over the snapshot table each time.
    if (now - this.lastComputed < 60_000) return;
    this.lastComputed = now;
    // Resort by decayed score rather than raw profitPerTrip: a route the
    // fleet has been leaning on recently sinks behind a fresher alternative
    // for the same good, even if its on-paper profit is still nominally
    // higher (last-known price, not yet refreshed) — see scoreRoute()'s own
    // comment. A heavily-sold route still wins if it's literally the only
    // one for its good (no trader sits idle over it), since nothing else
    // scores higher. Reassigning the parameter itself (not just
    // this.routes) matters: the per-good selection loops below read
    // `routes` directly, not `this.routes` — this.routes only backs
    // claim()'s own direct reads.
    this.coolOffMin = Math.max(0, tuning?.coolOffMin ?? 0);
    this.roundsMax = Math.max(0, tuning?.roundsMax ?? 0);
    this.buyRoundsMax = Math.max(0, tuning?.buyRoundsMax ?? 0);
    this.marketRecoveryMin = Math.max(0, tuning?.marketRecoveryMin ?? 0);
    this.routeBlockMin = Math.max(0, tuning?.routeBlockMin ?? 0);
    // Systems still behind the fresh-system gate (systemQueue.ts) are not offered to traders, as a buy or a sell leg. Empty = the
    // list is exactly as before.
    if (this.gatedSystems.size > 0) {
      const open = routes.filter((r) => !this.gatedSystems.has(r.buySystem) && !this.gatedSystems.has(r.sellSystem));
      if (open.length !== routes.length) {
        this.logger(`[dispatcher] ${routes.length - open.length} route(s) held behind the fresh-system gate (${[...this.gatedSystems].slice(0, 4).join(", ")})`);
        routes = open;
      }
    }
    // Routes another ship found dead on arrival stay out of everyone's list until the block lapses. Off (0), nothing is
    // recorded or filtered and the list is exactly as before.
    if (this.routeBlockMin > 0) {
      this.routeBlocks.prune(now);
      const held: string[] = [];
      const open = routes.filter((r) => {
        const why = this.routeBlocks.reasonFor(r, now);
        if (why) held.push(`${r.good} ${r.buyAt}>${r.sellAt}: ${why}`);
        return why === undefined;
      });
      if (held.length) {
        this.logger(`[dispatcher] ${held.length} route(s) held back as dead: ${[...new Set(held)].slice(0, 4).join("; ")}`);
        routes = open;
      }
    }
    // Any of the three rests a route, so any one being on needs this pass to run; with all at 0 it is skipped exactly as
    // before, and coolOffReason() returns undefined at 0 minutes.
    if (this.coolOffMin > 0 || this.roundsMax > 0 || this.buyRoundsMax > 0) {
      const open = routes.filter((r) => !this.routeCoolOff(r.good, r.buyAt, r.sellAt));
      if (open.length !== routes.length) {
        const rested = routes.filter((r) => !open.includes(r)).map((r) => `${r.good} ${r.buyAt}>${r.sellAt} (${this.routeCoolOff(r.good, r.buyAt, r.sellAt)})`);
        this.logger(`[dispatcher] route cool-off skips ${rested.length}: ${[...new Set(rested)].slice(0, 5).join("; ")}`);
        routes = open;
      }
    }
    // Plan on what a market we have been selling into probably pays now, not on the snapshot taken before we sold.
    // Off (marketRecoveryMin 0) the list is left exactly as it is.
    if (this.marketRecoveryMin > 0) {
      const adjusted: DispatchRoute[] = [];
      const notes: string[] = [];
      for (const r of routes) {
        const out = this.afterOwnSales(r, now);
        if (!out) {
          notes.push(`${r.good} ${r.buyAt}>${r.sellAt} dropped: no longer pays after our own sales`);
          continue;
        }
        if (out.reason) notes.push(`${r.good} ${r.buyAt}>${r.sellAt}: ${out.reason}`);
        adjusted.push(out.route);
      }
      if (notes.length) this.logger(`[dispatcher] sell-market recovery adjusts ${notes.length}: ${[...new Set(notes)].slice(0, 5).join("; ")}`);
      routes = adjusted;
    }
    routes = [...routes].sort((a, b) => this.scoreRoute(b) - this.scoreRoute(a));
    this.routes = routes;

    const sorted = [...traders].sort((a, b) => b.capacity - a.capacity);
    const usedKeys = new Set<string>();
    // Is a buy->sell leg flyable? Same system, one open gate, or (when the
    // operator has enabled it) a verified multi-hop path within the cap.
    const legConnected = (a: string, b: string): boolean =>
      a === b || canJump(a, b) || (crossSystem?.enabled === true && crossSystem.path(a, b) !== undefined);
    const pathCost = (path: string[]): number => {
      let total = 0;
      for (let i = 0; i + 1 < path.length; i++) total += crossSystem!.hopCost(path[i]!, path[i + 1]!);
      return total;
    };
    /** Credits a ship pays in gate jumps to get from one system to another: the sum over every hop, or the flat
     *  estimate for a single gate when cross-system routing is off. Zero for the same system. */
    const positioningCredits = (from: string | undefined, to: string | undefined): number => {
      if (from === undefined || to === undefined || from === to) return 0;
      if (canJump(from, to)) return crossSystem?.enabled ? pathCost([from, to]) : CROSS_SYSTEM_JUMP_COST_ESTIMATE;
      if (!crossSystem?.enabled) return 0;
      const path = crossSystem.path(from, to);
      return path ? pathCost(path) : 0;
    };
    const next = new Map<string, TraderAssignment>();

    /** Direct reserves the whole good; buy/sell/haul/contractBuy reserve
     *  just their side, so e.g. a buy trader and a sell trader can hold the
     *  same good at once. */
    const keyFor = (a: { good: string; role: TraderRole; slot?: number }): string =>
      a.role === "contractBuy" ? contractSlotKey(a.good, a.slot ?? 1)
        : a.role === "buy" || a.role === "sell" || a.role === "haul" ? `${a.good}:${a.role}` : a.good;

    // Reserve every key a manual override could touch — the operator's good
    // is off-limits to auto-assignment in any role, not just the one they set.
    for (const a of this.manual.values()) {
      usedKeys.add(a.good);
      usedKeys.add(`${a.good}:buy`);
      usedKeys.add(`${a.good}:sell`);
      usedKeys.add(`${a.good}:haul`);
      for (let k = 1; k <= MAX_CONTRACT_SLOTS; k++) usedKeys.add(contractSlotKey(a.good, k));
    }

    // Carry forward every busy trader's current assignment, whatever its role.
    //
    // Also record each busy direct trader's (good, sellAt) so the *new* work
    // built below can avoid handing the identical leg to a second, idle
    // trader — confirmed live: THEO-B was mid-haul on CLOTHING X1-XB94-K87 ->
    // X1-XB94-A1 (bought, in flight) when the very next recompute handed
    // THEO-A the *same* CLOTHING/A1 route fresh. usedKeys alone doesn't catch
    // this: it reserves the qualified `good@sellAt` key here, but the new
    // "best route for this good" work item below is keyed on the bare good
    // (no market qualifier — see its own comment), so the two keys never
    // collide and nothing stopped a second trader from being freshly
    // assigned the exact route the first was already flying.
    const sellMarketsInUse = new Map<string, Set<string>>();
    // A trip stays with its trader until the delivery is done, not just while
    // the hold is loaded: an empty trader already flying to its buy market (or
    // jumping toward it) kept being handed fresh work every cycle and turned
    // around mid-route, burning jumps. Track loaded -> empty to see completion,
    // and let a commitment lapse if no cargo has been bought within
    // COMMIT_GRACE_MS, or if the ship is at the buy waypoint and the route has
    // left the list.
    const nowMs = Date.now();
    const routeStillListed = (a: TraderAssignment): boolean =>
      routes.some((r) => r.good === a.good && r.buyAt === a.buyAt && r.sellAt === a.sellAt);
    for (const t of sorted) {
      const c = this.committed.get(t.shipSymbol);
      if (!c) continue;
      if (t.busy) {
        c.hadCargo = true;
        // A second leg's cargo is aboard: the ship bought leg 2 and is flying it.
        const flying = this.assignments.get(t.shipSymbol);
        const run = this.circuitRun.get(t.shipSymbol);
        if (flying?.circuit?.leg === 2 && run && run.leg2LoadedAt === undefined) {
          run.leg2LoadedAt = nowMs;
          this.circuitCounts.leg2Loaded += 1;
          this.circuitEvent(t.shipSymbol, "leg2_loaded", `leg 2 ${flying.good} ${flying.buyAt} -> ${flying.sellAt} bought and flying (${run.leg2ServedAt !== undefined ? Math.round((nowMs - run.leg2ServedAt) / 1000) : "?"}s after it was served)`, nowMs, log);
        }
      } else if (c.hadCargo) {
        this.committed.delete(t.shipSymbol);
        // The trip's cargo is sold: if it was leg 1 of a circuit, leg 2 may now be served.
        const planned = this.circuits.get(t.shipSymbol);
        if (planned) this.markLeg1Sold(t.shipSymbol, planned, nowMs, log);
        // If the trip that just ended was a circuit's second leg, the circuit is complete.
        const finished = this.assignments.get(t.shipSymbol);
        if (finished?.circuit?.leg === 2) {
          const run = this.circuitRun.get(t.shipSymbol);
          const cycle = run ? ` in ${Math.round((nowMs - run.plannedAt) / 1000)}s from planning (leg 2 was served ${run.leg2ServedAt !== undefined ? Math.round((nowMs - run.leg2ServedAt) / 1000) : "?"}s ago)` : "";
          this.circuitCounts.completed += 1;
          this.circuitRun.delete(t.shipSymbol);
          this.circuitEvent(t.shipSymbol, "completed", `circuit complete: leg 2 ${finished.good} ${finished.buyAt} -> ${finished.sellAt} sold${cycle}`, nowMs, log);
        }
        continue;
      }
      const a = this.assignments.get(t.shipSymbol);
      // Mid-flight to the buy waypoint the trip is never revoked for a changed
      // list; once the ship is standing at the buy waypoint with an empty hold
      // it may be re-ranked if the route is no longer listed.
      const atBuy = !!a && a.buyAt !== undefined && t.waypoint === a.buyAt;
      const lapsed = !a || a.source === "manual" || a.role !== "direct"
        || (!c.hadCargo && (nowMs - c.at > COMMIT_GRACE_MS || (atBuy && !routeStillListed(a))));
      if (lapsed) this.committed.delete(t.shipSymbol);
    }
    for (const t of sorted) {
      if (!(t.busy || this.committed.has(t.shipSymbol)) || this.manual.has(t.shipSymbol)) continue;
      const current = this.assignments.get(t.shipSymbol);
      if (!current) continue;
      // A leftover copy of an override the operator has since released.
      if (current.source === "manual") continue;
      // Key on the whole leg, not just the good.
      //
      // keyFor() collapses a direct assignment to its good alone, so two busy
      // traders carrying the same good collided here: the first kept its
      // route and the second silently fell through to the main loop and was
      // reassigned *while holding cargo* — usually to the `GOOD@sellAt`
      // variant, which is a different leg entirely. That is how DAGGER-17,
      // mid-trip with 18u ANTIMATTER bought for X1-KU72-I59, ended up pointed
      // at X1-TV75-X20F, a system it cannot reach.
      //
      // Two ships carrying the same good to *different* markets is exactly
      // what the sell-destination keying elsewhere in this file exists to
      // allow, so it must not be a collision here either. A ship already
      // holding cargo keeps its leg unconditionally: reassigning a hull
      // mid-haul strands what it is carrying, whatever else wants the slot.
      const key = current.role === "direct" && current.sellAt ? `${current.good}@${current.sellAt}` : keyFor(current);
      usedKeys.add(key);
      next.set(t.shipSymbol, current);
      if (current.role === "direct" && current.sellAt) {
        (sellMarketsInUse.get(current.good) ?? sellMarketsInUse.set(current.good, new Set()).get(current.good)!).add(current.sellAt);
      }
    }

    // A loaded trader with no assignment on record (the in-memory map is empty
    // after a restart or deploy) is still flying the trip its own held-route pin
    // describes. Rebuild its assignment from that pin so the fleet page shows
    // it, and so the trip is carried forward and reserved like any other.
    for (const f of inFlight ?? []) {
      if (next.has(f.shipSymbol) || this.manual.has(f.shipSymbol)) continue;
      const t = sorted.find((x) => x.shipSymbol === f.shipSymbol);
      if (!t?.busy) continue;
      next.set(f.shipSymbol, {
        shipSymbol: f.shipSymbol, good: f.good, role: "direct", buyAt: f.buyAt, sellAt: f.sellAt,
        profitPerTrip: 0, source: "auto",
      });
      this.committed.set(f.shipSymbol, { at: nowMs, hadCargo: true });
    }
    // Legs already in flight, from every trader's own pin. Reserve their sell
    // market and remember them for the per-market buyer count below. Falls back
    // to the carried-forward assignment for a busy ship with no pin.
    const inFlightLegs: { good: string; buyAt?: string; units: number }[] = [];
    const inFlightShips = new Set<string>();
    for (const f of inFlight ?? []) {
      inFlightShips.add(f.shipSymbol);
      inFlightLegs.push({ good: f.good, buyAt: f.buyAt, units: f.units });
      (sellMarketsInUse.get(f.good) ?? sellMarketsInUse.set(f.good, new Set()).get(f.good)!).add(f.sellAt);
      usedKeys.add(`${f.good}@${f.sellAt}`);
    }
    for (const [ship, a] of next) {
      if (inFlightShips.has(ship) || a.role !== "direct" || !a.buyAt) continue;
      const t = sorted.find((x) => x.shipSymbol === ship);
      if (t && (t.busy || this.committed.has(ship))) inFlightLegs.push({ good: a.good, buyAt: a.buyAt, units: t.capacity });
    }

    // Build this cycle's work list: one item per good with no warehouse
    // target (direct — today's only case), and one per targeted good that's
    // currently off-target (buy if under, sell if over; a good sitting right
    // at target needs nobody). Routes arrive pre-ranked by profit per trip,
    // so keeping only the first (best) route per good and re-sorting the
    // combined list preserves "most valuable opportunity first" across both
    // kinds of work.
    const targetsByGood = new Map(warehouseTargets.map((t) => [t.good, t]));
    const seenGood = new Set<string>();
    // `buySystem` is the system a trader has to be standing in (or one gate
    // from) to start this work. It is what makes the assignment loop below
    // locality-aware; work with no buy leg leaves it undefined and stays
    // assignable to anyone. `buyAt` is the actual waypoint within that
    // system — same-system reachability alone isn't enough: confirmed live,
    // DRAGOM-3 was assigned an AMMUNITION leg whose buy waypoint was 99
    // units away with an 80-unit tank, a route the trader's own
    // whyNotViable() correctly rejects but only *after* burning an
    // assignment cycle discovering that. buyAt lets the loop below check
    // the same fuel-distance constraint before handing the work out, not
    // after.
    // `sellAt`, only set for a `direct` item: the one case that needs the
    // *whole* round trip to fit a fuel tank, not just the leg to buyAt — see
    // reachable()'s own comment below for the live case this closes.
    // Units already spoken for, per contract good, by ships carrying a contract buy forward (busy ones hold its cargo):
    // each counts as its hold. The main loop adds every ship it assigns this cycle.
    const contractPromised = new Map<string, number>();
    const holdOf = new Map(sorted.map((t) => [t.shipSymbol, t.capacity]));
    for (const [shipSymbol, a] of next) {
      if (a.role === "contractBuy") contractPromised.set(a.good, (contractPromised.get(a.good) ?? 0) + (holdOf.get(shipSymbol) ?? 0));
    }
    const work: { key: string; make: (shipSymbol: string) => TraderAssignment; profitPerTrip: number; buySystem?: string; buyAt?: string; sellAt?: string; good?: string; buyPrice?: number; sellPrice?: number; volume?: number; buyVolume?: number; sellVolume?: number; tripSeconds?: number; secPerDist?: number; rawProfit?: number; profitByHold?: Record<string, number>; contractGood?: string; contractNeeded?: number }[] = [];
    for (const route of routes) {
      if (seenGood.has(route.good)) continue;
      seenGood.add(route.good);
      const target = targetsByGood.get(route.good);
      if (!target) {
        // A "direct" assignment is one trader flying the whole round trip
        // itself, so — unlike buy/sell/haul — it genuinely needs buyAt and
        // sellAt to both be reachable from each other. Cross-system is
        // allowed (TraderAgent.viableRoute() will fly it once the
        // connecting gate is complete), but skip it here if the gate isn't
        // open yet: otherwise this burns the good's assignment slot for a
        // full minute on a route no trader could actually take, while the
        // dashboard shows it as "assigned" and profitable.
        if (!legConnected(route.buySystem, route.sellSystem)) continue;
        // A busy trader already flying this exact good into this exact
        // market: don't hand a second trader the same leg. The secondary
        // "different market" loop below still gets a chance at this good —
        // it doesn't depend on a work item existing here.
        if (sellMarketsInUse.get(route.good)?.has(route.sellAt)) continue;
        // Decayed score for ranking against every other work item this
        // cycle (buy/sell/haul/contractBuy/other goods), not route's raw
        // profitPerTrip — otherwise a fatigued market's "second trader,
        // different market" fallback below can still out-rank this pick at
        // its own undiscounted number and win the trader anyway, quietly
        // undoing the whole point of resorting `routes` above. toAssignment()
        // below still builds the displayed TraderAssignment from the route's
        // real profitPerTrip — only this ranking figure is adjusted.
        work.push({ key: route.good, make: (s) => this.toAssignment(s, route), profitPerTrip: this.scoreRoute(route), buySystem: route.buySystem, buyAt: route.buyAt, sellAt: route.sellAt, good: route.good, buyPrice: route.buyPrice, sellPrice: route.sellPrice, volume: route.volume, buyVolume: route.buyVolume, sellVolume: route.sellVolume, tripSeconds: route.tripSeconds, secPerDist: route.secPerDist, rawProfit: route.profitPerTrip, profitByHold: route.profitByHold });
      } else if (target.balance < target.target) {
        work.push({ key: `${route.good}:buy`, make: (s) => this.toBuyAssignment(s, route), profitPerTrip: route.profitPerTrip, buySystem: route.buySystem, buyAt: route.buyAt });
      } else if (target.balance > target.target) {
        work.push({ key: `${route.good}:sell`, make: (s) => this.toSellAssignment(s, route), profitPerTrip: route.profitPerTrip });
      }
      // balance === target: on target, no trader needed for it this cycle.
    }
    // Second and subsequent routes for a good, keyed by sell destination
    // rather than by good alone.
    //
    // Confirmed live: with six traders and three profitable goods, three
    // traders sat idle every cycle, because the loop above emits exactly one
    // work item per good and a `direct` key reserves the whole good. The
    // original rule — no two traders on the same good — existed to stop them
    // converging on one market and collapsing its price, which is a real
    // effect: four consecutive sales at one waypoint took a good from 97,632
    // down to 26,604. Keying on the sell market keeps that protection while
    // putting the idle hulls to work, because two traders may share a good
    // only when they are selling into different markets.
    const emittedKeys = new Set(work.map((w) => w.key));
    // Routes arrive pre-ranked, so the first one seen for a good is the one
    // the loop above considered; anything after it is a fallback.
    const firstSeen = new Map<string, DispatchRoute>();
    for (const r of routes) if (!firstSeen.has(r.good)) firstSeen.set(r.good, r);
    // Sell markets already spoken for, per good — including the best route's.
    const sellTaken = new Map<string, Set<string>>();
    for (const w of work) {
      const best = firstSeen.get(w.key);
      if (best) sellTaken.set(w.key, new Set([best.sellAt]));
    }

    for (const route of routes) {
      if (targetsByGood.has(route.good)) continue; // warehousing owns this good's split
      if (firstSeen.get(route.good) === route) continue; // already considered above
      if (!legConnected(route.buySystem, route.sellSystem)) continue;
      const key = `${route.good}@${route.sellAt}`;
      if (emittedKeys.has(key)) continue;
      if (sellMarketsInUse.get(route.good)?.has(route.sellAt)) continue; // a busy trader already owns this market
      const taken = sellTaken.get(route.good);
      if (taken?.has(route.sellAt)) continue; // that market is already being sold into
      emittedKeys.add(key);
      (taken ?? sellTaken.set(route.good, new Set()).get(route.good)!).add(route.sellAt);
      // Decayed score here too — see the primary-loop push's own comment.
      work.push({ key, make: (sym) => this.toAssignment(sym, route), profitPerTrip: this.scoreRoute(route), buySystem: route.buySystem, buyAt: route.buyAt, sellAt: route.sellAt, good: route.good, buyPrice: route.buyPrice, sellPrice: route.sellPrice, volume: route.volume, buyVolume: route.buyVolume, sellVolume: route.sellVolume, tripSeconds: route.tripSeconds, secPerDist: route.secPerDist, rawProfit: route.profitPerTrip, profitByHold: route.profitByHold });
    }

    // Haul work is independent of the routes list — it's driven entirely by
    // what the warehouse already holds against what a mission still needs.
    // Priority is a simple proxy (bigger deliveries rank higher); it isn't
    // pretending to be a real profit figure the way route-derived items are.
    const seenHaulGood = new Set<string>();
    for (const h of haulTargets) {
      if (seenHaulGood.has(h.good)) continue; // one hauler per good per cycle, even if 2 missions need it
      seenHaulGood.add(h.good);
      const amount = Math.min(h.balance, h.needed);
      if (amount <= 0) continue;
      work.push({ key: `${h.good}:haul`, make: (s) => this.toHaulAssignment(s, h.good, h.targetWaypoint, amount * 50), profitPerTrip: amount * 50 });
    }
    // Mission-buy work shares the same `${good}:buy` key as a curated
    // warehousing buy — deliberately: a good should only ever appear in one
    // of the two lists, but if it somehow ended up in both, they should
    // compete for the one trader slot rather than double-assign it.
    const seenMissionBuyGood = new Set<string>();
    for (const b of missionBuyTargets) {
      if (seenMissionBuyGood.has(b.good)) continue; // one buyer per good per cycle, even if 2 missions need it
      seenMissionBuyGood.add(b.good);
      const shortfall = b.needed - b.balance;
      if (shortfall <= 0) continue; // warehouse already has enough for what's needed
      const priority = shortfall * 50;
      work.push({ key: `${b.good}:buy`, make: (s) => this.toBuyAssignment(s, { good: b.good, buyAt: b.buyAt, buyPrice: b.buyPrice, profitPerTrip: priority }, true), profitPerTrip: priority });
    }
    // Contract-buy work has its own `${good}:contractBuy` key, distinct from
    // an ordinary or mission buy on the same good — a contract needing IRON
    // shouldn't compete with (or get silently satisfied by) a warehouse-bound
    // IRON buy that was never headed for the contract's destination.
    const seenContractBuyGood = new Set<string>();
    for (const cb of contractBuyTargets) {
      if (seenContractBuyGood.has(cb.good)) continue; // one buyer per good per cycle, even across multiple contracts
      seenContractBuyGood.add(cb.good);
      if (cb.needed <= 0) continue;
      // needed*100 is still what's shown on the assignment itself (the
      // dashboard displays it as "+N/trip", and the contract's real payout
      // is a lump sum on full completion, not a per-trip figure — showing
      // it there would overstate what any one trip actually earns).
      const displayProfit = cb.needed * 100;
      // But needed*100 alone must never decide who gets picked: it
      // collapses to nearly nothing right as a contract nears completion —
      // confirmed live, a 64-unit shortfall scored ~6400 (competitive with
      // real trade routes), but the same contract at a 4-unit shortfall
      // scored 400, well below typical arbitrage profitPerTrip, so nothing
      // picked up the last few units for a long while. The payout is a
      // lump sum on completion, not per unit, so finishing the last 4
      // units is worth exactly as much as the first 60 were — rank by the
      // real value when the caller has it, falling back to the same
      // needed*100 estimate only when it doesn't (e.g. existing tests that
      // construct a target with no `value`).
      const rankPriority = cb.value ?? displayProfit; // outranks an equivalent mission-buy shortfall — contracts have hard deadlines, warehousing doesn't
      // One buyer per good normally. With ships pinned to contract duty, up to one extra buyer per such ship (max
      // MAX_CONTRACT_SLOTS) may buy the same good in parallel, each only while the ships already on it do not cover the
      // units still needed (checked per ship in the loop below), so a contract finishes sooner without over-buying.
      const dutyShips = sorted.filter((t) => this.contractDuty.has(t.shipSymbol)).length;
      const slots = Math.max(1, Math.min(MAX_CONTRACT_SLOTS, dutyShips));
      for (let k = 1; k <= slots; k++) {
        work.push({ key: contractSlotKey(cb.good, k), make: (s) => this.toContractBuyAssignment(s, cb, displayProfit, k), profitPerTrip: rankPriority - (k - 1) * 0.001, contractGood: cb.good, contractNeeded: cb.needed });
      }
    }
    // A direct leg at or under the trader's own margin floor is one every trader refuses (whyNotViable() applies the
    // same effectiveMarginFloor to the same doctrine value), so handing it out only burns a recompute and a price-
    // discovery hop. Confirmed live 2026-10-07 13:45-14:11: THEOREM_DEV_2-1/-3 were handed FOOD (+208), COPPER (+61),
    // FABRICS (+167/+179), AMMUNITION (+179) and FERTILIZERS (+100) against a 300c floor, one after another.
    const floorFlat = tuning?.marginFloor ?? 0;
    const floorDropped: ExplainRoute[] = [];
    for (let i = work.length - 1; i >= 0; i--) {
      const w = work[i]!;
      if (w.sellAt === undefined || w.buyPrice === undefined || w.sellPrice === undefined) continue;
      if (w.sellPrice - w.buyPrice <= effectiveMarginFloor(floorFlat, w.buyPrice)) {
        floorDropped.push(explainRouteOf(w, undefined));
        work.splice(i, 1);
      }
    }
    work.sort((a, b) => b.profitPerTrip - a.profitPerTrip);
    // Per-ship reasons for dispatch_explain: every work item an idle trader was checked against and turned down, and why.
    const explainRejections = new Map<string, ExplainRejection[]>();

    let leavingHome = 0;
    // Units already promised to each (buy market, good) THIS cycle. The ask in
    // the route list is the price right now, so a second and third trader sent
    // to the same market would otherwise each be scored as the only buyer.
    const impact = tuning?.buyImpactPerUnit ?? BUY_IMPACT_PER_UNIT;
    const cap = tuning?.maxTradersPerBuyMarket ?? MAX_TRADERS_PER_BUY_MARKET;
    const marginFloorPerUnit = tuning?.marginFloor ?? 0;
    const pendingUnits = new Map<string, number>();
    const pendingTraders = new Map<string, number>();
    const buyKey = (w: { buyAt?: string; good?: string }) => (w.buyAt && w.good ? `${w.buyAt}|${w.good}` : undefined);
    for (const f of inFlightLegs) {
      const k = buyKey(f);
      if (!k) continue;
      pendingUnits.set(k, (pendingUnits.get(k) ?? 0) + f.units);
      pendingTraders.set(k, (pendingTraders.get(k) ?? 0) + 1);
    }
    // Extra cost of this trader's units given what is already promised there,
    // or undefined when the extra buyer should not be sent at all.
    const impactCost = (w: { buyAt?: string; good?: string; buyPrice?: number; sellPrice?: number; volume?: number; buyVolume?: number }): number | undefined => {
      const k = buyKey(w);
      if (!k || w.buyPrice === undefined || w.volume === undefined) return 0;
      const traders = pendingTraders.get(k) ?? 0;
      if (traders === 0) return 0;
      if (traders >= cap) return undefined;
      // Per-unit impact follows the market's own lot size (4.5% per lot, the same figure trip slippage uses), so a
      // 300-unit market is not charged the 20-unit market's 0.2%/unit it was measured on. An explicit tuning value
      // (tests, an operator override) and a route with no known lot size keep the flat default.
      const perUnit = tuning?.buyImpactPerUnit === undefined && w.buyVolume && w.buyVolume > 0 ? PRICE_IMPACT_PER_LOT / w.buyVolume : impact;
      const ask = w.buyPrice * (1 + perUnit) ** (pendingUnits.get(k) ?? 0);
      if (w.sellPrice !== undefined && w.sellPrice - ask < marginFloorPerUnit) return undefined;
      return w.volume * (ask - w.buyPrice);
    };
    // Follow-on lookahead (chain.ts, docs/backhaul-plan.md): credit a route for the best trip that can start where it
    // sells. Off (weight 0) it changes nothing; nothing below is computed.
    const chainPolicy: ChainPolicy = {
      ...DEFAULT_CHAIN_POLICY,
      followOnWeight: Math.max(0, tuning?.followOnWeight ?? 0),
      horizonMinutes: tuning?.followOnHorizonMin ?? DEFAULT_CHAIN_POLICY.horizonMinutes,
      jumpSeconds: tuning?.jumpSeconds ?? DEFAULT_CHAIN_POLICY.jumpSeconds,
    };
    // Two-leg circuits (circuit.ts): off at weight 0, which also forgets any plan still held.
    const circuitPolicy: CircuitPolicy = {
      ...DEFAULT_CIRCUIT_POLICY,
      weight: Math.max(0, tuning?.circuitWeight ?? 0),
      horizonMinutes: tuning?.circuitHorizonMin ?? DEFAULT_CIRCUIT_POLICY.horizonMinutes,
      returnShare: Math.min(1, Math.max(0, tuning?.circuitReturnShare ?? DEFAULT_CIRCUIT_POLICY.returnShare)),
      crossSystem: tuning?.circuitCrossSystem ?? DEFAULT_CIRCUIT_POLICY.crossSystem,
      minGain: Math.max(0, tuning?.circuitMinGain ?? DEFAULT_CIRCUIT_POLICY.minGain),
      minGainShare: Math.max(0, tuning?.circuitMinGainShare ?? DEFAULT_CIRCUIT_POLICY.minGainShare),
      minLeg2Runs: Math.max(0, tuning?.circuitMinLeg2Runs ?? DEFAULT_CIRCUIT_POLICY.minLeg2Runs),
    };
    for (const note of this.circuitNotes.splice(0)) log?.(note);
    for (const [ship, planned] of this.circuits) {
      if (circuitPolicy.weight <= 0 || circuitExpired(planned, nowMs, circuitPolicy)) {
        this.circuits.delete(ship);
        this.circuitRun.delete(ship);
        const why = circuitPolicy.weight <= 0 ? "circuits switched off" : "plan expired";
        this.circuitEvent(ship, "dropped", `dropped leg 2 ${legId(planned.leg2)} — ${why}`, nowMs, log, why);
      }
    }
    // Second legs kept for a ship that has not served them yet: nobody else is handed or credited them.
    const circuitHeld = new Map<string, string>();
    for (const [ship, planned] of this.circuits) circuitHeld.set(legId(planned.leg2), ship);
    // Also the BUY side of those second legs. Two circuits planning a second leg at the same buy market (2026-10-11: two
    // ships both chose SHIP_PARTS at D40, for different sell markets) double the buying there and erode the margin both
    // were counting on, so a leg whose buy market and good a circuit already holds is not offered as another's second leg.
    const circuitBuyHeld = new Map<string, string>();
    const buySide = (l: { good: string; buyAt: string }): string => `${l.good}|${l.buyAt}`;
    for (const [ship, planned] of this.circuits) circuitBuyHeld.set(buySide(planned.leg2), ship);
    const workLegId = (w: { good?: string; buyAt?: string; sellAt?: string }): string | undefined =>
      w.good !== undefined && w.buyAt !== undefined && w.sellAt !== undefined ? legId({ good: w.good, buyAt: w.buyAt, sellAt: w.sellAt }) : undefined;
    const chainCandidates: ChainCandidate[] = chainPolicy.followOnWeight > 0 || circuitPolicy.weight > 0
      ? work.flatMap((w) =>
          w.sellAt !== undefined && w.buyAt !== undefined && w.buySystem !== undefined && w.good !== undefined && w.tripSeconds && w.secPerDist
            ? [{ key: w.key, good: w.good, buyAt: w.buyAt, buySystem: w.buySystem, sellAt: w.sellAt, profitPerTrip: w.profitPerTrip, tripSeconds: w.tripSeconds, secPerDist: w.secPerDist, buyPrice: w.buyPrice, sellPrice: w.sellPrice, units: w.volume, buyVolume: w.buyVolume, sellVolume: w.sellVolume }]
            : [])
      : [];
    const reservedFollowOns = new Set<string>();
    // Is another trader already buying this good at this market, whether mid-haul or heading there now? A second leg is
    // flown minutes after it is planned, and a buyer already on it will have eaten the margin by then. 2026-10-11: both
    // circuits planned after the staying-power setting was eased had a second leg another ship was buying at the same
    // market (EQUIPMENT at K100 for THEOREM-11, MEDICINE at K101 for THEOREM-4), and the first was dropped as "no longer on
    // the board" before it ran. Counts this cycle's assignments so far (carried-forward and manual ones included) and trips
    // already in flight.
    const someoneBuying = (c: { good: string; buyAt: string }): boolean =>
      (pendingTraders.get(`${c.buyAt}|${c.good}`) ?? 0) > 0
      || [...next.values()].some((a) => a.good === c.good && a.buyAt === c.buyAt && (a.role === "direct" || a.role === "contractBuy"));
    const chainCtx = {
      distanceBetween,
      crossSystemCost: (from: string, to: string): number | undefined => {
        if (canJump(from, to)) return CROSS_SYSTEM_JUMP_COST_ESTIMATE;
        if (!crossSystem?.enabled) return undefined;
        const path = crossSystem.path(from, to);
        return path ? pathCost(path) : undefined;
      },
      crossSystemHops: (from: string, to: string): number | undefined => {
        if (canJump(from, to)) return 1;
        const path = crossSystem?.enabled ? crossSystem.path(from, to) : undefined;
        return path ? path.length - 1 : undefined;
      },
      unavailable: (c: ChainCandidate) => usedKeys.has(c.key) || reservedFollowOns.has(c.key) || circuitHeld.has(legId(c)) || circuitBuyHeld.has(buySide(c)) || someoneBuying(c),
    };
    const candidateByKey = new Map(chainCandidates.map((c) => [c.key, c]));
    // Can this trader take this work, from where it stands? (Hoisted out of the loop so route-first matching can ask it
    // about ships other than the one being served.)
    // Every fuel check on a multi-jump path: each intermediate system's arrival gate to its exit gate must fit the tank,
    // or a known fuel stop in that system must relay it. Jumps themselves cost no fuel, so the tank is taken as full on
    // arrival. (Only the first system's gate was checked before this.)
    const relayBlock = (path: string[], t: (typeof traders)[number]): string | undefined => {
      if (t.fuelCapacity === undefined) return undefined;
      for (let i = 1; i + 1 < path.length; i++) {
        const sys = path[i]!;
        const arrive = crossSystem?.gateFor?.(sys, path[i - 1]!);
        const leave = crossSystem?.gateFor?.(sys, path[i + 1]!);
        if (arrive === undefined || leave === undefined) continue;
        if (distanceBetween(arrive, leave) > t.fuelCapacity && !(hasFuelStop?.(sys, arrive, leave, t.fuelCapacity) ?? false)) {
          return `the relay through ${sys} from ${arrive} to ${leave} is beyond its fuel range`;
        }
      }
      return undefined;
    };
    /** Why this trader cannot take this work from where it stands, or undefined when it can. Cross-system reasons name
     *  the guard that failed, so dispatch_explain says which one blocks a route. */
    const whyUnreachable = (t: (typeof traders)[number], w: { buySystem?: string; buyAt?: string; sellAt?: string; profitPerTrip?: number }): string | undefined => {
      // A local-only ship (reach "system") never leaves its system, whatever the route's gate distance: see shipReach.ts.
      const outside = routeOutsideReach(t.reach, t.system, { buySystem: w.buySystem, sellSystem: w.sellAt !== undefined ? systemOfWaypoint(w.sellAt) : undefined });
      if (outside !== undefined) return outside;
      if (w.buySystem === undefined || t.system === undefined) return undefined;
      if (w.buySystem !== t.system) {
        if (!canJump(t.system, w.buySystem)) {
          if (!crossSystem?.enabled) return `${w.buySystem} is not one gate from ${t.system} and cross-system routes are off`;
          const path = crossSystem.path(t.system, w.buySystem);
          if (!path || path.length < 3) return `no finished gate path from ${t.system} to ${w.buySystem} within the jump limit`;
          if ((w.profitPerTrip ?? 0) <= pathCost(path)) return `the first trip does not cover the ${path.length - 1}-jump positioning cost`;
          if (crossSystem.homeSystem !== undefined && t.system === crossSystem.homeSystem) {
            const reserve = crossSystem.homeReserve ?? 1;
            const stayingHome = traders.filter((x) => x.system === crossSystem.homeSystem).length - 1 - leavingHome;
            if (stayingHome < reserve) return `${t.system} keeps its last ${reserve} trader(s) at home`;
          }
          const relay = relayBlock(path, t);
          if (relay !== undefined) return relay;
        }
        // The ship also has to reach the gate in its own system. The route check above only knows a jump is possible: a
        // 300-tank trader 399 from the gate cannot cruise there and drifted for 2h09m (THEO-27, 2026-10-09 17:50), so a
        // gate beyond the tank is unreachable unless a fuel stop relays it, exactly as for a same-system leg.
        const nextSystem = canJump(t.system, w.buySystem) ? w.buySystem : crossSystem?.path(t.system, w.buySystem)?.[1];
        const gate = nextSystem !== undefined ? crossSystem?.gateFor?.(t.system, nextSystem) : undefined;
        if (gate !== undefined && t.waypoint !== undefined && t.fuelCapacity !== undefined &&
            distanceBetween(t.waypoint, gate) > t.fuelCapacity &&
            !(hasFuelStop?.(t.system, t.waypoint, gate, t.fuelCapacity) ?? false)) return `gate ${gate} is beyond fuel range from ${t.waypoint}`;
        return undefined;
      }
      if (w.buyAt === undefined || t.waypoint === undefined || t.fuelCapacity === undefined) return undefined;
      if (distanceBetween(t.waypoint, w.buyAt) > t.fuelCapacity &&
          !(hasFuelStop?.(t.system, t.waypoint, w.buyAt, t.fuelCapacity) ?? false)) return `buy market ${w.buyAt} is beyond fuel range from ${t.waypoint}`;
      // A `direct` item (sellAt set) needs the *whole round trip* to fit the
      // tank, not just the leg to buyAt — a same-system route whose sell
      // market sits further out than the trader's own fuel capacity still
      // passed the check above and only failed later, inside the trader's
      // own findRoute(), after an assignment cycle was already burned on it.
      // Confirmed live: THEO-11 (80-unit tank) was hand ADVANCED_CIRCUITRY
      // X1-XB94-D43 -> X1-XB94-A4 (91 units apart) three separate times
      // across recomputes despite 14 other same-system routes it could
      // actually fly sitting right there in the same work list, because
      // nothing here ever checked the sell leg. Cross-system sellAt is
      // untouched — that leg is a jump, not a fuel-distance flight, and
      // canJump() above already covers whether it is possible at all.
      if (w.sellAt === undefined) return undefined;
      const sellSystem = w.sellAt.slice(0, w.sellAt.lastIndexOf("-"));
      if (sellSystem !== w.buySystem) return undefined;
      if (distanceBetween(w.buyAt, w.sellAt) <= t.fuelCapacity) return undefined;
      return (hasFuelStop?.(w.buySystem, w.buyAt, w.sellAt, t.fuelCapacity) ?? false)
        ? undefined : `sell market ${w.sellAt} is beyond fuel range from ${w.buyAt}`;
    };
    const reachableFor = (t: (typeof traders)[number], w: { buySystem?: string; buyAt?: string; sellAt?: string; profitPerTrip?: number }): boolean =>
      whyUnreachable(t, w) === undefined;
    /** Seconds a ship in another system needs before it can start buying: one cooldown per jump, plus the flight from
     *  where it sits to its gate. The flight matters: two ships in the same system both sit `hops` jumps away, so without
     *  it the one standing at the gate and the one across the system looked identical and the choice fell to hold size. */
    const crossSystemPositioning = (t: (typeof traders)[number], w: { buySystem?: string; secPerDist?: number }): number => {
      let seconds = (chainCtx.crossSystemHops(t.system!, w.buySystem!) ?? 1) * chainPolicy.jumpSeconds;
      const nextSystem = canJump(t.system!, w.buySystem!) ? w.buySystem : crossSystem?.path(t.system!, w.buySystem!)?.[1];
      const gate = nextSystem !== undefined ? crossSystem?.gateFor?.(t.system!, nextSystem) : undefined;
      if (gate !== undefined && t.waypoint !== undefined && w.secPerDist) seconds += distanceBetween(t.waypoint, gate) * w.secPerDist;
      return seconds;
    };
    // Route-first matching (matching.ts): off at topN 0. Otherwise the ships best suited to the top routes are served
    // first, in route order, then everyone else by hold size as before.
    const isDeclinedBy = (ship: string, w: { good?: string; buyAt?: string; sellAt?: string }): boolean => {
      const r = this.declined.get(ship);
      return !!r && r.until > nowMs && w.good === r.good && (r.wholeGood || (w.buyAt === r.buyAt && w.sellAt === r.sellAt));
    };
    let loopOrder = sorted;
    const matchPolicy: MatchPolicy = { ...DEFAULT_MATCH_POLICY, topN: Math.max(0, Math.floor(tuning?.matchTopN ?? 0)) };
    if (matchPolicy.topN > 0) {
      const idle = sorted.filter((t) => !t.busy && !this.manual.has(t.shipSymbol) && !next.has(t.shipSymbol) && !this.committed.has(t.shipSymbol));
      const tradeItems = work.filter((w) => w.sellAt !== undefined && w.buyAt !== undefined && !usedKeys.has(w.key));
      const byKey = new Map(tradeItems.map((w) => [w.key, w]));
      const traderBySymbol = new Map(idle.map((t) => [t.shipSymbol, t]));
      const matched = matchShips(
        tradeItems.map((w) => ({ key: w.key, profitPerTrip: w.profitPerTrip, rawProfit: w.rawProfit, profitByHold: w.profitByHold, volume: w.volume, tripSeconds: w.tripSeconds })),
        idle.map((t) => ({ shipSymbol: t.shipSymbol, capacity: t.capacity })),
        {
          positioningSeconds: (ship, item) => {
            const t = traderBySymbol.get(ship.shipSymbol);
            const w = byKey.get(item.key);
            if (!t || !w || !reachableFor(t, w) || isDeclinedBy(t.shipSymbol, w)) return undefined;
            if (w.buySystem !== undefined && t.system !== undefined && w.buySystem !== t.system) {
              return crossSystemPositioning(t, w);
            }
            return t.waypoint && w.buyAt && w.secPerDist ? distanceBetween(t.waypoint, w.buyAt) * w.secPerDist : 0;
          },
        },
        matchPolicy,
      );
      for (const note of matched.notes) log?.(note);
      const first = matched.order.flatMap((sym) => traderBySymbol.get(sym) ?? []);
      const firstSet = new Set(matched.order);
      loopOrder = [...first, ...sorted.filter((t) => !firstSet.has(t.shipSymbol))];
    }
    // Cross-system ships choose first, so a local-only ship (reach "system") gets only what is still unclaimed after
    // them, and its in-system routes never take a cross-system one away. Within each group the order is unchanged.
    loopOrder = [...loopOrder.filter((t) => t.reach !== "system"), ...loopOrder.filter((t) => t.reach === "system")];
    for (const t of loopOrder) {
      const manual = this.manual.get(t.shipSymbol);
      if (manual) {
        next.set(t.shipSymbol, manual);
        continue;
      }
      if (next.has(t.shipSymbol)) continue;
      // A busy trader with no carried-forward record here means the
      // dispatcher's own in-memory assignments map was wiped (a restart)
      // while this ship was mid-haul — cargo already bought, in the hold,
      // for a trip this process now has no memory of. Handing it fresh
      // work would abandon that cargo: this same recompute would rank it
      // for some unrelated good, and the ship has no room left to act on
      // it (hold already full). Confirmed live: THEO-1 was mid-flight to
      // sell 40u MEDICINE when a restart landed between the buy completing
      // and its held_route pin being written; every recompute since then
      // handed it a fresh, unexecutable good (MACHINERY, then ANTIMATTER)
      // while it sat full and unable to buy any of them. Leave it alone —
      // TraderAgent's own tick() already recovers a mid-trip good from
      // held_route (see initialHeldRoutes) independently of anything the
      // dispatcher assigns, and that is the one place with the real cargo
      // detail (which good, how much) to act on correctly.
      if (t.busy) continue;
      // Prefer work this ship can actually start on. `work` is ranked by
      // profit alone, and taking the global best for every trader is a
      // scheduler with no node affinity: when X1-RD37 was first surveyed its
      // fresh spreads took nine of the top twelve slots, and all six traders
      // were handed routes starting in a system none of them could reach —
      // a ~20-second error loop with nothing trading at all.
      //
      // Reachability, not just distance: single-hop, matching what the
      // executor can fly. Work with no buy leg, or a trader whose system we
      // do not know, stays assignable as before. The fallback keeps the old
      // behaviour rather than idling a hull, so a fleet that genuinely has
      // only distant work still attempts it — the trader's own viableRoute()
      // is the authority that declines it.
      //
      // Same-system work still needs its own fuel check: system membership
      // alone doesn't mean the ship can actually reach the buy waypoint
      // *from where it's standing* — see the distanceBetween param's own
      // comment for the live DRAGOM-3 case this closes.
      //
      // 2026-09-21: a leg beyond single-hop range no longer disqualifies the
      // work item outright — hasFuelStop() (when the caller provides one)
      // checks whether a same-system relay through a known fuel stop closes
      // the gap, the same capability ShipProxy.navigateTo() already uses to
      // actually fly a leg like this once assigned (see viableRoute()'s
      // matching fix in trader.ts for the full story: DRUGS/ASSAULT_RIFLES/
      // FIREARMS/CLOTHING, all selling at a market too far for any one
      // trader's direct tank range, sat unclaimed with idle capacity and
      // real profit on the board for many minutes at a stretch). No
      // hasFuelStop wired in still means "reject beyond single-hop range",
      // same as before — this is additive, not a loosened default.
      // Positioning a trader more than one jump away is the expensive case, so
      // it carries extra guards: the doctrine switch, a verified path within
      // the cap, the hold being empty (busy traders never get here), the FIRST
      // trip alone covering the positioning cost, and at least `homeReserve`
      // traders staying behind in the home system.
      const reachable = (w: Parameters<typeof reachableFor>[1]): boolean => reachableFor(t, w);
      // Best REACHABLE item by score. A multi-hop positioning trip is scored
      // net of a third of its positioning cost (the trader will usually run
      // that lane a few times once it is there); everything else keeps its
      // plain profit, so with the switch off this is exactly the old
      // first-reachable-in-ranked-order pick.
      let item: (typeof work)[number] | undefined;
      let itemFollowOn: FollowOn | undefined;
      let itemCircuit: Circuit | undefined;
      let leg2Served: { score: number; reason: string } | undefined;
      let bestScore = -Infinity;
      const refused = this.declined.get(t.shipSymbol);
      if (refused && refused.until <= nowMs) this.declined.delete(t.shipSymbol);
      const isRefused = (w: { good?: string; buyAt?: string; sellAt?: string }): boolean =>
        !!refused && refused.until > nowMs && w.good === refused.good &&
        (refused.wholeGood || (w.buyAt === refused.buyAt && w.sellAt === refused.sellAt));
      // What a work item is worth to THIS trader before any lookahead: the route's score less the extra-buyer impact,
      // discounted for the flight to its buy market. Undefined when it cannot or should not be handed to this trader.
      const scoreItem = (w: (typeof work)[number]): { score: number; penalty: number; positioning: number } | undefined => {
        if (usedKeys.has(w.key) || !reachable(w) || isRefused(w)) return undefined;
        const extra = impactCost(w);
        if (extra === undefined) return undefined; // an extra buyer here is not worth it / over the cap
        // Direct routes carry a time-scaled score (see scoreRoute()); keep the extra buyers' impact cost on the
        // same scale, and charge the flight from this trader to the buy market against the trip's own time.
        const timeScale = w.tripSeconds ? REFERENCE_TRIP_SECONDS / w.tripSeconds : 1;
        let penalty = extra * timeScale;
        let score = w.profitPerTrip - penalty;
        let positioning = 0;
        if (w.tripSeconds && w.secPerDist && w.buyAt && t.waypoint && t.system !== undefined && w.buySystem === t.system) {
          positioning = distanceBetween(t.waypoint, w.buyAt) * w.secPerDist;
          score *= w.tripSeconds / (w.tripSeconds + positioning);
        }
        if (score <= 0) return undefined;
        if (w.buySystem !== undefined && t.system !== undefined && w.buySystem !== t.system) {
          // Another system: the ship sits out one jump cooldown per hop before it can buy.
          positioning = crossSystemPositioning(t, w);
          // The same wait counts against the plain score when the route has a trip time to scale it by (a same-system
          // route in another system, or a cross-system route, which fleet.ts now gives one): before this, a trip that
          // needed jumps was ranked as if it started the moment the ship picked it.
          if (w.tripSeconds) score *= w.tripSeconds / (w.tripSeconds + positioning);
          // The jumps this ship must make to reach the buy market are credits it pays on this trip, so they come off
          // the score in full. (Previously only a third came off, and a single gate jump came off nothing.) The
          // route's own profitPerTrip is not changed; this is the ship-specific cost of getting there.
          const share = positioningCredits(t.system, w.buySystem);
          score -= share;
          penalty += share;
          if (score <= 0) return undefined;
        }
        return { score, penalty, positioning };
      };
      // Why THIS trader was refused a work item, in the order scoreItem() checks it. Only ever called for an item
      // scoreItem() has already turned down, so the final fallthrough is the net-score test.
      const noteRejected = (w: (typeof work)[number], reason: string): void => {
        const list = explainRejections.get(t.shipSymbol) ?? [];
        if (list.length < EXPLAIN_MAX_REJECTIONS) list.push({ key: w.key, good: w.good ?? goodOfKey(w.key), sellAt: w.sellAt, reason });
        explainRejections.set(t.shipSymbol, list);
      };
      const whyRejected = (w: (typeof work)[number]): string => {
        if (usedKeys.has(w.key)) return "already claimed this cycle";
        if (isRefused(w)) return "declined by this trader";
        const unreachable = whyUnreachable(t, w);
        if (unreachable !== undefined) return unreachable;
        const buyers = (buyKey(w) ? pendingTraders.get(buyKey(w)!) : undefined) ?? 0;
        if (buyers >= cap) return `${buyers} traders already buying at ${w.buyAt} (cap ${cap})`;
        if (impactCost(w) === undefined) return `margin gone after ${buyers} buyer(s) at ${w.buyAt}`;
        return "net score at or below zero after positioning";
      };
      // A circuit planned for this ship gets exactly one chance at its second leg, and only after the first leg's cargo
      // was sold. If that leg has gone off the board, lost its margin or become unreachable, the circuit is dropped and
      // the ship is picked for like any other idle trader.
      const planned = this.circuits.get(t.shipSymbol);
      if (planned) {
        this.circuits.delete(t.shipSymbol);
        const lid = legId(planned.leg2);
        circuitHeld.delete(lid);
        circuitBuyHeld.delete(buySide(planned.leg2));
        if (!planned.leg1Sold) {
          this.circuitRun.delete(t.shipSymbol);
          this.circuitEvent(t.shipSymbol, "dropped", `dropped leg 2 ${lid} — leg 1 never ran`, nowMs, log, "leg 1 never ran");
        } else {
          const w2 = work.find((w) => workLegId(w) === lid);
          const s2 = w2 ? scoreItem(w2) : undefined;
          // Cash free to spend after leg 1's proceeds (the caller passes the wallet less the cash floor).
          const afford = w2 && tuning?.circuitCash !== undefined && w2.buyPrice !== undefined
            ? { spendable: tuning.circuitCash, cost: w2.buyPrice * Math.min(w2.volume ?? t.capacity, t.capacity) }
            : undefined;
          // "no longer available" hid two different causes, so say which: the leg left the board altogether (its margin
          // or its market went), or it is still there but this ship may not take it (and why).
          const verdict = !w2
            ? { ok: false, reason: "no longer on the board: it is not in this cycle's work list (margin gone, market stale, or taken as another route's sell market)" }
            : !s2
              ? { ok: false, reason: `still on the board but refused for this ship: ${whyRejected(w2)}` }
              : judgeLeg2(planned, s2.score, circuitPolicy, afford);
          if (w2 && s2 && verdict.ok) {
            item = w2;
            bestScore = s2.score;
            leg2Served = { score: s2.score, reason: verdict.reason };
          } else {
            this.circuitRun.delete(t.shipSymbol);
            this.circuitEvent(t.shipSymbol, "dropped", `dropped leg 2 ${lid} — ${verdict.reason}`, nowMs, log, verdict.reason);
          }
        }
      }
      const scoredItems: (typeof work)[number][] = [];
      for (const w of work) {
        // A ship already on its planned second leg is not scored against the rest: say so for each route it was passed over.
        if (leg2Served) {
          if (w !== item) noteRejected(w, `on a planned circuit leg 2 (${item?.key ?? "?"})`);
          continue;
        }
        const slot = contractSlotOf(w.key);
        const onDuty = this.contractDuty.has(t.shipSymbol);
        if (onDuty && slot === 0) { noteRejected(w, "this ship is on contract duty (contract work only)"); continue; }
        // Once any ship is pinned to contract duty, contract buys are its job: an unpinned ship may not take them, even
        // when the pinned ship is busy and so not in this cycle's idle list (where dutyShips is 0 and slot 1 would
        // otherwise open to anyone). Seen live 2026-10-13: a 490-unit freighter was handed a small contract while the
        // ship pinned to it was elsewhere.
        if (slot >= 1 && !onDuty && this.contractDuty.size > 0) { noteRejected(w, "contract work is kept for the ships pinned to contract duty"); continue; }
        if (slot >= 2) {
          if (!onDuty) { noteRejected(w, "a parallel contract buyer is for ships on contract duty"); continue; }
          if ((contractPromised.get(w.contractGood ?? "") ?? 0) >= (w.contractNeeded ?? 0)) { noteRejected(w, "the ships already on this contract good cover the units still needed"); continue; }
        }
        const lid = workLegId(w);
        const holder = lid !== undefined ? circuitHeld.get(lid) : undefined;
        if (holder !== undefined && holder !== t.shipSymbol) { noteRejected(w, "held for another ship's circuit"); continue; }
        const scored = scoreItem(w);
        if (!scored) { noteRejected(w, whyRejected(w)); continue; }
        scoredItems.push(w);
        let score = scored.score;
        let followOn: FollowOn | undefined;
        let circuit: Circuit | undefined;
        const candidate = candidateByKey.get(w.key);
        // A first leg in another system is credited only for what it earns after the jump cooldown: scoreItem() charges
        // that time as `positioning` (seen live 2026-10-09: before it did, THEO-51 and THEO-27 were planned GY77 pairs
        // from JX83 and sat empty).
        if (circuitPolicy.weight > 0 && w.sellAt !== undefined && candidate) {
          const found = bestCircuit(candidate, chainCandidates, chainCtx, circuitPolicy);
          const credited = circuitScore(score, found, scored.positioning, scored.penalty, circuitPolicy);
          if (found && credited > score) { circuit = found; score = credited; }
        }
        if (!circuit && chainPolicy.followOnWeight > 0 && w.sellAt !== undefined) {
          followOn = bestFollowOn(w.sellAt, chainCandidates, chainCtx, chainPolicy, w.key);
          score = chainScore(score, followOn, chainPolicy);
        }
        if (score > bestScore) { bestScore = score; item = w; itemFollowOn = followOn; itemCircuit = circuit; }
      }
      for (const w of scoredItems) if (w !== item) noteRejected(w, `outscored by ${item?.key ?? "nothing"}`);
      if (item && crossSystem?.enabled && crossSystem.homeSystem !== undefined && t.system === crossSystem.homeSystem && item.buySystem !== undefined && item.buySystem !== t.system) {
        leavingHome += 1;
      }
      if (!item) {
        // Extends the temporary diagnostic below (docs: "why are idle
        // traders not getting assigned when profitable routes exist",
        // 06eb755) — that log answered "how many/what work" but not "why
        // did THIS ship reject THIS item," which is the actual open
        // question after confirming live (2026-09-21) that idle traders sat
        // unassigned for 30+ minutes with real, same-system, profitable
        // work sitting in the list every cycle. One line per idle ship that
        // got nothing, showing the exact reason each of its top candidates
        // was rejected — cross-system/no-jump vs. over-fuel-range vs.
        // already claimed this cycle. Remove alongside 06eb755's log once
        // both questions are answered.
        if (log && !t.busy && !this.manual.has(t.shipSymbol) && work.length > 0) {
          const reasons = work.slice(0, 4).map((w) => {
            if (usedKeys.has(w.key)) return `${w.key}:claimed-this-cycle`;
            if (w.buySystem === undefined) return `${w.key}:no-buySystem(always-reachable)`;
            if (t.system === undefined) return `${w.key}:trader-has-no-system(always-reachable)`;
            if (w.buySystem !== t.system) return `${w.key}:cross-system(${t.system}->${w.buySystem}) canJump=${canJump(t.system, w.buySystem)}`;
            if (w.buyAt === undefined || t.waypoint === undefined || t.fuelCapacity === undefined) return `${w.key}:missing-position-data(always-reachable)`;
            const d = distanceBetween(t.waypoint, w.buyAt);
            return `${w.key}:buyDist(${t.waypoint}->${w.buyAt})=${d} vs cap=${t.fuelCapacity} -> ${d > t.fuelCapacity ? "TOO FAR" : "in range, check sell leg"}`;
          });
          log(`dispatch: ${t.shipSymbol} idle, sys=${t.system ?? "?"} wp=${t.waypoint ?? "?"} fuelCap=${t.fuelCapacity ?? "?"} got nothing — ${reasons.join(" | ")}`);
        }
        continue;
      }
      usedKeys.add(item.key);
      if (item.contractGood !== undefined) contractPromised.set(item.contractGood, (contractPromised.get(item.contractGood) ?? 0) + t.capacity);
      const made = item.make(t.shipSymbol);
      if (leg2Served && planned) {
        made.circuit = { leg: 2, leg2: { ...planned.leg2, score: Math.round(leg2Served.score) }, explain: leg2Served.reason };
        const run = this.circuitRun.get(t.shipSymbol);
        if (run) run.leg2ServedAt = nowMs;
        this.circuitCounts.leg2Served += 1;
        this.circuitEvent(t.shipSymbol, "leg2_served", `leg 2 ${item.key} served — ${leg2Served.reason}`, nowMs, log);
      }
      if (circuitPolicy.weight > 0 && !itemCircuit && !leg2Served && item.sellAt !== undefined) {
        // Why this route got no circuit, so the horizon and return share can be tuned from what the dispatcher sees.
        const cand = candidateByKey.get(item.key);
        const own = scoreItem(item);
        if (cand) log?.(`dispatch circuit: ${t.shipSymbol} ${item.key} — ${circuitReport(cand, chainCandidates, chainCtx, circuitPolicy, bestScore, own?.positioning, own?.penalty)}`);
      }
      if (itemCircuit) {
        const l2 = itemCircuit.leg2;
        made.circuit = { leg: 1, leg2: { good: l2.good, buyAt: l2.buyAt, sellAt: l2.sellAt, score: Math.round(l2.profitPerTrip) }, explain: itemCircuit.explain };
        this.circuits.set(t.shipSymbol, { leg2: { good: l2.good, buyAt: l2.buyAt, sellAt: l2.sellAt }, leg2Score: l2.profitPerTrip, at: nowMs });
        circuitHeld.set(legId(l2), t.shipSymbol);
        circuitBuyHeld.set(buySide(l2), t.shipSymbol);
        this.circuitRun.set(t.shipSymbol, { plannedAt: nowMs, leg1: item.key, leg2: legId(l2) });
        this.circuitCounts.planned += 1;
        this.circuitEvent(t.shipSymbol, "planned", `${item.key} — ${itemCircuit.explain}`, nowMs, log);
      }
      if (itemFollowOn) {
        made.followOn = { good: itemFollowOn.candidate.good, buyAt: itemFollowOn.candidate.buyAt, sellAt: itemFollowOn.candidate.sellAt, score: Math.round(itemFollowOn.score) };
        if (chainPolicy.reserveFollowOn) reservedFollowOns.add(itemFollowOn.candidate.key);
        log?.(`dispatch chain: ${t.shipSymbol} ${item.key} — ${explainChain(item.profitPerTrip, itemFollowOn, chainPolicy)}`);
      }
      next.set(t.shipSymbol, made);
      if (made.role === "direct" && made.source === "auto" && made.buyAt && made.sellAt) {
        this.committed.set(t.shipSymbol, { at: nowMs, hadCargo: false });
      }
      const bk = buyKey(item);
      if (bk && item.volume !== undefined) {
        pendingUnits.set(bk, (pendingUnits.get(bk) ?? 0) + item.volume);
        pendingTraders.set(bk, (pendingTraders.get(bk) ?? 0) + 1);
      }
    }
    this.assignments = next;

    // Snapshot for dispatch_explain. A route's claimant is whoever holds the same good into the same market this cycle.
    const claimantOf = (w: (typeof work)[number]): string | undefined => {
      if (w.good === undefined) return undefined;
      for (const [ship, a] of next) if (a.good === w.good && (w.sellAt === undefined || a.sellAt === w.sellAt)) return ship;
      return undefined;
    };
    this.lastExplain = {
      at: now,
      routes: work.slice(0, EXPLAIN_MAX_ROUTES).map((w) => explainRouteOf(w, claimantOf(w))),
      floorDropped: floorDropped.slice(0, EXPLAIN_MAX_ROUTES),
      traders: sorted.map((t): ExplainTrader => {
        const a = next.get(t.shipSymbol);
        const assigned = !a ? undefined
          : a.role === "direct" ? (a.sellAt ? `${a.good}@${a.sellAt}` : a.good)
          : `${a.good}:${a.role}`;
        return {
          ship: t.shipSymbol, system: t.system, waypoint: t.waypoint, busy: t.busy === true, assigned,
          rejected: explainRejections.get(t.shipSymbol) ?? [],
        };
      }),
    };

    if (log) {
      const states = formatTraderStates(traders.length, summarizeTraderStates(traders, new Set(next.keys()), new Set(this.manual.keys())));
      const workSummary = work.map((w) => `${w.key}=${Math.round(w.profitPerTrip)}`).join(", ") || "(none)";
      const assignedSummary = [...next.entries()].map(([ship, a]) => `${ship}:${a.good}(${a.role})`).join(", ") || "(none)";
      log(`dispatch recompute: ${states} | work: ${workSummary} | assigned: ${assignedSummary}`);
    }
  }
}
