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

/** Hard backstop: no more than this many traders are sent to buy the same good
 *  at the same market in one dispatch cycle, whatever the margin says. */
export const MAX_TRADERS_PER_BUY_MARKET = 3;

/** How long an assigned trip may sit without its cargo ever being bought
 *  (positioning jumps included) before the trader is released for new work. */
export const COMMIT_GRACE_MS = 3 * 60 * 60_000;

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

import { REFERENCE_TRIP_SECONDS, effectiveMarginFloor } from "./routeEconomics.js";
import { bestFollowOn, chainScore, explainChain, DEFAULT_CHAIN_POLICY, type ChainCandidate, type ChainPolicy, type FollowOn } from "./chain.js";
import { bestCircuit, circuitExpired, circuitReport, circuitScore, judgeLeg2, legId, DEFAULT_CIRCUIT_POLICY, type Circuit, type CircuitPolicy, type PlannedCircuit } from "./circuit.js";

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
  /** True only for a "buy" assignment sourced to feed an active mission's
   *  outstanding demand — exempts it from the trader's protectedGoods
   *  block, which otherwise refuses to buy a mission-reserved good. */
  missionBuy?: boolean;
  /** Informational: the route the dispatcher expected this trip to lead into (see chain.ts). The trader does not read it. */
  followOn?: { good: string; buyAt: string; sellAt: string; score: number };
  /** Informational: this trip is one leg of a two-leg circuit (see circuit.ts). Leg 1 names the leg planned to follow;
   *  leg 2 is that leg being served. The trader does not read it; the dispatcher keeps the second leg for this ship. */
  circuit?: { leg: 1 | 2; leg2: { good: string; buyAt: string; sellAt: string; score: number }; explain: string };
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
  /** The last serialized circuits handed to / loaded by the persistence layer, to tell when they changed. */
  private savedCircuits = "[]";
  /** The ranked route list from the last recompute, used to serve live claims. */
  private routes: DispatchRoute[] = [];
  private lastComputed = 0;
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
  recordSale(good: string, sellAt: string, units: number): void {
    const key = `${good}@${sellAt}`;
    const list = this.recentSales.get(key) ?? [];
    list.push({ units, at: Date.now() });
    this.recentSales.set(key, list);
  }

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

  /** Routes a single trader should fly, honoring a manual override if set. */
  assignmentFor(shipSymbol: string): TraderAssignment | undefined {
    return this.manual.get(shipSymbol) ?? this.assignments.get(shipSymbol);
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

  /** Planned circuits as JSON, once, when they have changed since the last call (undefined otherwise), so the caller can
   *  persist them across a restart. An empty plan list is "[]". */
  circuitSnapshot(): string | undefined {
    const json = JSON.stringify([...this.circuits.entries()]);
    if (json === this.savedCircuits) return undefined;
    this.savedCircuits = json;
    return json;
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
  private toContractBuyAssignment(shipSymbol: string, target: ContractBuyTarget, priority: number): TraderAssignment {
    return {
      shipSymbol,
      good: target.good,
      role: "contractBuy",
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

  /** Give up a claim (ship scrapped, role changed, route abandoned). */
  release(shipSymbol: string): void {
    this.assignments.delete(shipSymbol);
    this.forgetCircuit(shipSymbol, "the ship was released");
  }

  private forgetCircuit(shipSymbol: string, why: string): void {
    const planned = this.circuits.get(shipSymbol);
    if (!planned) return;
    this.circuits.delete(shipSymbol);
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
      if (this.committed.get(shipSymbol)?.hadCargo) planned.leg1Sold = true;
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
    traders: { shipSymbol: string; capacity: number; busy?: boolean; system?: string; waypoint?: string; fuelCapacity?: number }[],
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
    tuning?: { buyImpactPerUnit?: number; maxTradersPerBuyMarket?: number; marginFloor?: number; followOnWeight?: number; followOnHorizonMin?: number; circuitWeight?: number; circuitHorizonMin?: number; circuitCash?: number; circuitReturnShare?: number; jumpSeconds?: number },
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
    const next = new Map<string, TraderAssignment>();

    /** Direct reserves the whole good; buy/sell/haul/contractBuy reserve
     *  just their side, so e.g. a buy trader and a sell trader can hold the
     *  same good at once. */
    const keyFor = (a: { good: string; role: TraderRole }): string =>
      a.role === "buy" || a.role === "sell" || a.role === "haul" || a.role === "contractBuy" ? `${a.good}:${a.role}` : a.good;

    // Reserve every key a manual override could touch — the operator's good
    // is off-limits to auto-assignment in any role, not just the one they set.
    for (const a of this.manual.values()) {
      usedKeys.add(a.good);
      usedKeys.add(`${a.good}:buy`);
      usedKeys.add(`${a.good}:sell`);
      usedKeys.add(`${a.good}:haul`);
      usedKeys.add(`${a.good}:contractBuy`);
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
      if (t.busy) c.hadCargo = true;
      else if (c.hadCargo) {
        this.committed.delete(t.shipSymbol);
        // The trip's cargo is sold: if it was leg 1 of a circuit, leg 2 may now be served.
        const planned = this.circuits.get(t.shipSymbol);
        if (planned) planned.leg1Sold = true;
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
    const work: { key: string; make: (shipSymbol: string) => TraderAssignment; profitPerTrip: number; buySystem?: string; buyAt?: string; sellAt?: string; good?: string; buyPrice?: number; sellPrice?: number; volume?: number; tripSeconds?: number; secPerDist?: number }[] = [];
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
        work.push({ key: route.good, make: (s) => this.toAssignment(s, route), profitPerTrip: this.scoreRoute(route), buySystem: route.buySystem, buyAt: route.buyAt, sellAt: route.sellAt, good: route.good, buyPrice: route.buyPrice, sellPrice: route.sellPrice, volume: route.volume, tripSeconds: route.tripSeconds, secPerDist: route.secPerDist });
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
      work.push({ key, make: (sym) => this.toAssignment(sym, route), profitPerTrip: this.scoreRoute(route), buySystem: route.buySystem, buyAt: route.buyAt, sellAt: route.sellAt, good: route.good, buyPrice: route.buyPrice, sellPrice: route.sellPrice, volume: route.volume, tripSeconds: route.tripSeconds, secPerDist: route.secPerDist });
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
      work.push({ key: `${cb.good}:contractBuy`, make: (s) => this.toContractBuyAssignment(s, cb, displayProfit), profitPerTrip: rankPriority });
    }
    // A direct leg at or under the trader's own margin floor is one every trader refuses (whyNotViable() applies the
    // same effectiveMarginFloor to the same doctrine value), so handing it out only burns a recompute and a price-
    // discovery hop. Confirmed live 2026-10-07 13:45-14:11: THEOREM_DEV_2-1/-3 were handed FOOD (+208), COPPER (+61),
    // FABRICS (+167/+179), AMMUNITION (+179) and FERTILIZERS (+100) against a 300c floor, one after another.
    const floorFlat = tuning?.marginFloor ?? 0;
    for (let i = work.length - 1; i >= 0; i--) {
      const w = work[i]!;
      if (w.sellAt === undefined || w.buyPrice === undefined || w.sellPrice === undefined) continue;
      if (w.sellPrice - w.buyPrice <= effectiveMarginFloor(floorFlat, w.buyPrice)) work.splice(i, 1);
    }
    work.sort((a, b) => b.profitPerTrip - a.profitPerTrip);

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
    const impactCost = (w: { buyAt?: string; good?: string; buyPrice?: number; sellPrice?: number; volume?: number }): number | undefined => {
      const k = buyKey(w);
      if (!k || w.buyPrice === undefined || w.volume === undefined) return 0;
      const traders = pendingTraders.get(k) ?? 0;
      if (traders === 0) return 0;
      if (traders >= cap) return undefined;
      const ask = w.buyPrice * (1 + impact) ** (pendingUnits.get(k) ?? 0);
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
    };
    for (const note of this.circuitNotes.splice(0)) log?.(note);
    for (const [ship, planned] of this.circuits) {
      if (circuitPolicy.weight <= 0 || circuitExpired(planned, nowMs, circuitPolicy)) {
        this.circuits.delete(ship);
        log?.(`dispatch circuit: ${ship} dropped leg 2 ${legId(planned.leg2)} — ${circuitPolicy.weight <= 0 ? "circuits switched off" : "plan expired"}`);
      }
    }
    // Second legs kept for a ship that has not served them yet: nobody else is handed or credited them.
    const circuitHeld = new Map<string, string>();
    for (const [ship, planned] of this.circuits) circuitHeld.set(legId(planned.leg2), ship);
    const workLegId = (w: { good?: string; buyAt?: string; sellAt?: string }): string | undefined =>
      w.good !== undefined && w.buyAt !== undefined && w.sellAt !== undefined ? legId({ good: w.good, buyAt: w.buyAt, sellAt: w.sellAt }) : undefined;
    const chainCandidates: ChainCandidate[] = chainPolicy.followOnWeight > 0 || circuitPolicy.weight > 0
      ? work.flatMap((w) =>
          w.sellAt !== undefined && w.buyAt !== undefined && w.buySystem !== undefined && w.good !== undefined && w.tripSeconds && w.secPerDist
            ? [{ key: w.key, good: w.good, buyAt: w.buyAt, buySystem: w.buySystem, sellAt: w.sellAt, profitPerTrip: w.profitPerTrip, tripSeconds: w.tripSeconds, secPerDist: w.secPerDist }]
            : [])
      : [];
    const reservedFollowOns = new Set<string>();
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
      unavailable: (c: ChainCandidate) => usedKeys.has(c.key) || reservedFollowOns.has(c.key) || circuitHeld.has(legId(c)),
    };
    const candidateByKey = new Map(chainCandidates.map((c) => [c.key, c]));
    for (const t of sorted) {
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
      const multiHopOk = (w: { buySystem?: string; profitPerTrip?: number }, from: string): boolean => {
        if (!crossSystem?.enabled || w.buySystem === undefined) return false;
        const path = crossSystem.path(from, w.buySystem);
        if (!path || path.length < 3) return false; // 1 hop is handled by canJump above
        if ((w.profitPerTrip ?? 0) <= pathCost(path)) return false; // first trip must net positive
        if (crossSystem.homeSystem !== undefined && from === crossSystem.homeSystem) {
          const reserve = crossSystem.homeReserve ?? 1;
          const stayingHome = traders.filter((x) => x.system === crossSystem.homeSystem).length - 1 - leavingHome;
          if (stayingHome < reserve) return false;
        }
        return true;
      };
      const reachable = (w: { buySystem?: string; buyAt?: string; sellAt?: string; profitPerTrip?: number }): boolean => {
        if (w.buySystem === undefined || t.system === undefined) return true;
        if (w.buySystem !== t.system) {
          const jumpOk = canJump(t.system, w.buySystem) || multiHopOk(w, t.system);
          if (!jumpOk) return false;
          // The ship also has to reach the gate in its own system. The route check above only knows a jump is possible: a
          // 300-tank trader 399 from the gate cannot cruise there and drifted for 2h09m (THEO-27, 2026-10-09 17:50), so a
          // gate beyond the tank is unreachable unless a fuel stop relays it, exactly as for a same-system leg.
          const nextSystem = canJump(t.system, w.buySystem) ? w.buySystem : crossSystem?.path(t.system, w.buySystem)?.[1];
          const gate = nextSystem !== undefined ? crossSystem?.gateFor?.(t.system, nextSystem) : undefined;
          if (gate !== undefined && t.waypoint !== undefined && t.fuelCapacity !== undefined &&
              distanceBetween(t.waypoint, gate) > t.fuelCapacity &&
              !(hasFuelStop?.(t.system, t.waypoint, gate, t.fuelCapacity) ?? false)) return false;
          return true;
        }
        if (w.buyAt === undefined || t.waypoint === undefined || t.fuelCapacity === undefined) return true;
        if (distanceBetween(t.waypoint, w.buyAt) > t.fuelCapacity &&
            !(hasFuelStop?.(t.system, t.waypoint, w.buyAt, t.fuelCapacity) ?? false)) return false;
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
        if (w.sellAt === undefined) return true;
        const sellSystem = w.sellAt.slice(0, w.sellAt.lastIndexOf("-"));
        if (sellSystem !== w.buySystem) return true;
        if (distanceBetween(w.buyAt, w.sellAt) <= t.fuelCapacity) return true;
        return hasFuelStop?.(w.buySystem, w.buyAt, w.sellAt, t.fuelCapacity) ?? false;
      };
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
          positioning = (chainCtx.crossSystemHops(t.system, w.buySystem) ?? 1) * chainPolicy.jumpSeconds;
          // The same wait counts against the plain score when the route has a trip time to scale it by (a same-system
          // route in another system, or a cross-system route, which fleet.ts now gives one): before this, a trip that
          // needed jumps was ranked as if it started the moment the ship picked it.
          if (w.tripSeconds) score *= w.tripSeconds / (w.tripSeconds + positioning);
          if (crossSystem?.enabled && !canJump(t.system, w.buySystem)) {
            const path = crossSystem.path(t.system, w.buySystem);
            if (path) {
              const share = pathCost(path) / 3;
              score -= share;
              penalty += share;
            }
          }
        }
        return { score, penalty, positioning };
      };
      // A circuit planned for this ship gets exactly one chance at its second leg, and only after the first leg's cargo
      // was sold. If that leg has gone off the board, lost its margin or become unreachable, the circuit is dropped and
      // the ship is picked for like any other idle trader.
      const planned = this.circuits.get(t.shipSymbol);
      if (planned) {
        this.circuits.delete(t.shipSymbol);
        const lid = legId(planned.leg2);
        circuitHeld.delete(lid);
        if (!planned.leg1Sold) {
          log?.(`dispatch circuit: ${t.shipSymbol} dropped leg 2 ${lid} — leg 1 never ran`);
        } else {
          const w2 = work.find((w) => workLegId(w) === lid);
          const s2 = w2 ? scoreItem(w2) : undefined;
          // Cash free to spend after leg 1's proceeds (the caller passes the wallet less the cash floor).
          const afford = w2 && tuning?.circuitCash !== undefined && w2.buyPrice !== undefined
            ? { spendable: tuning.circuitCash, cost: w2.buyPrice * Math.min(w2.volume ?? t.capacity, t.capacity) }
            : undefined;
          const verdict = judgeLeg2(planned, s2?.score, circuitPolicy, afford);
          if (w2 && s2 && verdict.ok) {
            item = w2;
            bestScore = s2.score;
            leg2Served = { score: s2.score, reason: verdict.reason };
          } else {
            log?.(`dispatch circuit: ${t.shipSymbol} dropped leg 2 ${lid} — ${verdict.reason}`);
          }
        }
      }
      for (const w of leg2Served ? [] : work) {
        const lid = workLegId(w);
        const holder = lid !== undefined ? circuitHeld.get(lid) : undefined;
        if (holder !== undefined && holder !== t.shipSymbol) continue; // kept for another ship's circuit
        const scored = scoreItem(w);
        if (!scored) continue;
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
      const made = item.make(t.shipSymbol);
      if (leg2Served && planned) {
        made.circuit = { leg: 2, leg2: { ...planned.leg2, score: Math.round(leg2Served.score) }, explain: leg2Served.reason };
        log?.(`dispatch circuit: ${t.shipSymbol} leg 2 ${item.key} — ${leg2Served.reason}`);
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
        log?.(`dispatch circuit: ${t.shipSymbol} ${item.key} — ${itemCircuit.explain}`);
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

    if (log) {
      const idleCount = traders.filter((t) => !t.busy && !this.manual.has(t.shipSymbol)).length;
      const workSummary = work.map((w) => `${w.key}=${Math.round(w.profitPerTrip)}`).join(", ") || "(none)";
      const assignedSummary = [...next.entries()].map(([ship, a]) => `${ship}:${a.good}(${a.role})`).join(", ") || "(none)";
      log(`dispatch recompute: ${traders.length} traders (${idleCount} idle) | work: ${workSummary} | assigned: ${assignedSummary}`);
    }
  }
}
