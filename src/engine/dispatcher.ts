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
  distance: number;
  fuelUnits: number;
  fuelCost: number;
  profitPerTrip: number;
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
    const sold = this.recentVolume(route.good, route.sellAt);
    if (sold <= 0) return route.profitPerTrip;
    return route.profitPerTrip / (1 + sold / Math.max(route.volume, 1));
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
    if (assignment) {
      this.manual.set(shipSymbol, { ...assignment, source: "manual" });
    } else {
      this.manual.delete(shipSymbol);
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
    for (const t of sorted) {
      if (!t.busy || this.manual.has(t.shipSymbol)) continue;
      const current = this.assignments.get(t.shipSymbol);
      if (!current) continue;
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
    const work: { key: string; make: (shipSymbol: string) => TraderAssignment; profitPerTrip: number; buySystem?: string; buyAt?: string; sellAt?: string }[] = [];
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
        if (route.buySystem !== route.sellSystem && !canJump(route.buySystem, route.sellSystem)) continue;
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
        work.push({ key: route.good, make: (s) => this.toAssignment(s, route), profitPerTrip: this.scoreRoute(route), buySystem: route.buySystem, buyAt: route.buyAt, sellAt: route.sellAt });
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
      if (route.buySystem !== route.sellSystem && !canJump(route.buySystem, route.sellSystem)) continue;
      const key = `${route.good}@${route.sellAt}`;
      if (emittedKeys.has(key)) continue;
      if (sellMarketsInUse.get(route.good)?.has(route.sellAt)) continue; // a busy trader already owns this market
      const taken = sellTaken.get(route.good);
      if (taken?.has(route.sellAt)) continue; // that market is already being sold into
      emittedKeys.add(key);
      (taken ?? sellTaken.set(route.good, new Set()).get(route.good)!).add(route.sellAt);
      // Decayed score here too — see the primary-loop push's own comment.
      work.push({ key, make: (sym) => this.toAssignment(sym, route), profitPerTrip: this.scoreRoute(route), buySystem: route.buySystem, buyAt: route.buyAt, sellAt: route.sellAt });
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
    work.sort((a, b) => b.profitPerTrip - a.profitPerTrip);

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
      const reachable = (w: { buySystem?: string; buyAt?: string; sellAt?: string }): boolean => {
        if (w.buySystem === undefined || t.system === undefined) return true;
        if (w.buySystem !== t.system) return canJump(t.system, w.buySystem);
        if (w.buyAt === undefined || t.waypoint === undefined || t.fuelCapacity === undefined) return true;
        if (distanceBetween(t.waypoint, w.buyAt) > t.fuelCapacity) return false;
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
        return distanceBetween(w.buyAt, w.sellAt) <= t.fuelCapacity;
      };
      const item = work.find((w) => !usedKeys.has(w.key) && reachable(w));
      if (!item) continue;
      usedKeys.add(item.key);
      next.set(t.shipSymbol, item.make(t.shipSymbol));
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
