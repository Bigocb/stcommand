import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";
import type { SurveyPool } from "./survey.js";
import type { Task, TaskResult } from "./scheduler.js";
import { type AgentStep, IDLE_STEP, Pending } from "./agentStep.js";
import { Registry } from "./registry.js";
import { standDownReason } from "./intent.js";
import { ShipProxy } from "./shipProxy.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

export interface AgentOptions {
  /** Repair this ship where it stands; forwarded to the shared executor. */
  repairHere?: (shipSymbol: string) => Promise<void>;
  api: SpaceTradersAPI;
  /** Logger callback; defaults to console.log. */
  log?: (msg: string) => void;
  /** Optional persistence hook, called for sell/refuel transactions. */
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "SELL" | "REFUEL" | "PURCHASE";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** Called with this ship when it holds cargo. Returns a destination to fly to, `true` if handled, or falsy if nothing to do. */
  deliverCargo?: (ship: Ship) => Promise<string | true | null | undefined>;
  /** Called for notable events (extract, sell, refuel, navigate) for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Shared survey registry: surveyor scouts deposit, miners consume. */
  surveyPool?: SurveyPool;
  /** Trade symbols reserved for missions; these must never be sold/jettisoned. */
  protectedGoods?: () => Set<string>;
  /** Credits actually free to spend — already floor-adjusted (fleet.ts's
   *  spendableCredits(), not raw balance) — caps how much this ship's own
   *  arbitrage buying can spend. Undefined (no fleet wired in, e.g. a bare
   *  test) means unconstrained, matching this class's existing behavior. */
  getCredits?: () => number;
  /**
   * Chart the given system and re-seed this agent's waypoint positions from it.
   * The registry answers from the live atlas, so a system already loaded needs
   * nothing here — but a system nobody has ever scanned is genuinely absent
   * from it, and this is what pulls one in. A ship parked in such a system
   * comes back from a restart with no coordinates for where it is standing,
   * and every distance it computes is Infinity until this runs.
   */
  ensureSystemCharted?: (systemSymbol: string) => Promise<void>;
  /** Marketplace waypoints to tour periodically so price snapshots stay fresh. */
  marketTourTargets?: () => Promise<string[]>;
  /** Markets whose snapshots are older than the freshness window — tour these first. */
  staleMarketTargets?: () => Promise<string[]>;
  /** Shipyard waypoints to tour periodically so ship stock stays fresh. */
  shipyardTourTargets?: () => Promise<string[]>;
  /** Called when the ship docks at a shipyard so its inventory can be recorded. */
  recordShipyard?: (waypointSymbol: string) => Promise<void>;
  /** Stationary keeper: the market this ship polls on a timer to keep prices fresh. */
  keeperMarket?: () => string | undefined;
  /**
   * Whether the ship is allowed to act at all right now. False while the fleet
   * is halted.
   *
   * Halt used to gate only `FleetManager.tick()`, so pressing it stopped the
   * coordinator while every ship kept mining, buying and selling — and the one
   * thing that *did* stop was `rescueStranded()`. A halted fleet therefore kept
   * burning fuel with recovery switched off, which is the worst combination.
   */
  /**
   * This ship's committed intent, read live from the fleet's board. An agent
   * stands down rather than acting when the fleet itself is driving the hull
   * — see intent.ts's drivenByFleet(). Optional, so an agent built without a
   * board (a test, a bare CLI run) behaves exactly as before.
   */
  intentFor?: () => import("./intent.js").ShipIntent | undefined;
  shouldRun?: () => boolean;
}

/** Coordinates of a waypoint within a system, used for distance/fuel estimation. */
export interface WaypointPos {
  symbol: string;
  x: number;
  y: number;
  type?: components["schemas"]["WaypointType"];
}

/** A decision point in the ship lifecycle. */
export type ShipGoal =
  | { kind: "mine"; target: string }
  | { kind: "sell"; at: string }
  | { kind: "refuel"; at: string }
  | { kind: "buy"; good: string; units: number; at: string }
  | { kind: "survey"; target: string }
  | { kind: "idle"; waypoint?: string };

const ORE_GOODS = [
  "IRON_ORE",
  "COPPER_ORE",
  "ALUMINUM_ORE",
  "SILVER_ORE",
  "GOLD_ORE",
  "PLATINUM_ORE",
  "DIAMONDS",
  "URANITE_ORE",
  "MERITIUM_ORE",
  "QUARTZ_SAND",
  "SILICON_CRYSTALS",
  "PRECIOUS_STONES",
  "ICE_WATER",
  "AMMONIA_ICE",
];

/** Maps a basic (saleable) good to the processed good refine produces from it (10:1). */
const REFINE_RECIPES: Record<string, "IRON" | "COPPER" | "SILVER" | "GOLD" | "ALUMINUM" | "PLATINUM" | "URANITE" | "MERITIUM" | "FUEL"> = {
  IRON_ORE: "IRON",
  COPPER_ORE: "COPPER",
  ALUMINUM_ORE: "ALUMINUM",
  SILVER_ORE: "SILVER",
  GOLD_ORE: "GOLD",
  PLATINUM_ORE: "PLATINUM",
  URANITE_ORE: "URANITE",
  MERITIUM_ORE: "MERITIUM",
};

/**
 * Drives a single ship through the survival loop:
 * orbit → navigate → extract → (cargo full) → dock → sell → refuel → repeat.
 * Uses market snapshots to decide where to mine and where to sell.
 */
export class ShipAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: AgentOptions["recordLedger"];
  private readonly deliverCargo: AgentOptions["deliverCargo"];
  private readonly onActivity: AgentOptions["onActivity"];
  private readonly recordMarket: AgentOptions["recordMarket"];
  /** The world, held by reference — see registry.ts. */
  private registry: Registry = Registry.standalone();
  private readonly surveyPool: SurveyPool | undefined;
  private readonly protectedGoods?: () => Set<string>;
  private readonly getCredits?: AgentOptions["getCredits"];
  private readonly ensureSystemCharted?: AgentOptions["ensureSystemCharted"];
  private readonly marketTourTargets?: AgentOptions["marketTourTargets"];
  private readonly staleMarketTargets?: AgentOptions["staleMarketTargets"];
  private readonly shipyardTourTargets?: AgentOptions["shipyardTourTargets"];
  private readonly recordShipyard?: (waypointSymbol: string) => Promise<void>;
  private readonly keeperMarket?: () => string | undefined;
  private readonly intentFor?: AgentOptions["intentFor"];
  private readonly shouldRun?: () => boolean;
  private readonly proxy: ShipProxy;
  /** Every `this.ship` read and write in this class goes through the one copy
   *  the proxy owns — see shipProxy.ts. */
  private get ship(): Ship { return this.proxy.getShip(); }
  private set ship(s: Ship) { this.proxy.setShip(s); }
  private goal: ShipGoal = { kind: "idle" };
  private suspended = false;
  /** The currently in-flight loop iteration (tick/surveyScout/tourScout/keeperPoll), if any.
   *  suspend() awaits this so a caller that's about to mutate this ship's nav state directly
   *  via the raw API (rescue tender dispatch, mission carrier handoff) can't race an iteration
   *  that's already mid-flight against stale cached ship state. */
  private inFlight: Promise<unknown> | null = null;
  private surveyedFields = new Set<string>();
  /**
   * The waypoint of an extraction session still in progress, or null. Under
   * the scheduler a mining loop no longer runs to a full hold inside one
   * tick — each extraction's cooldown ends the tick via CooldownPending and
   * the next tick re-enters. Without this, that next tick would see a hold
   * with a few units in it and fly off to sell them (tick()'s step 2), so a
   * miner would haul five units at a time. Set on entry to mineAndRefine()/
   * extractUntilFull(), cleared when either finishes for real (full hold,
   * or a failure that ends the session) or when the ship is no longer here.
   */
  private miningSession: string | null = null;
  /** The survey the current extraction session is working from, so re-entering
   *  the session after a cooldown reuses it instead of paying for (and cooling
   *  down after) a fresh survey before every single extraction. */
  private activeSurvey?: { waypoint: string; survey: components["schemas"]["Survey"] };
  /** Operator-chosen asteroid field; overrides the ship's own nearest-field pick. */
  private pinnedMiningTarget?: string;
  private marketTourIndex = 0;
  running = false;
  private get currentStep(): AgentStep { return this.proxy.getStep(); }
  private set currentStep(s: AgentStep) { this.proxy.setStep(s); }
  /** True only for the exact duration of a nextTask()-family run() closure's
   *  call into tick()/surveyScout()/tourScout()/keeperPoll() — see
   *  agentStep.ts's NavigationPending doc comment for why this is scoped
   *  this narrowly rather than a flag set once and left true: dispatchTo()
   *  also reaches navigateTo(), directly from fleet.ts, never through any of
   *  those four methods, and must keep blocking exactly as before. */
  private get schedulerDriven(): boolean { return this.proxy.schedulerDriven; }
  private set schedulerDriven(v: boolean) { this.proxy.schedulerDriven = v; }

  /** What this ship is doing right now, if it's mid-navigation or mid-transaction — see agentStep.ts. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: AgentOptions) {
    this.symbol = ship.symbol;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.deliverCargo = opts.deliverCargo;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.surveyPool = opts.surveyPool;
    this.protectedGoods = opts.protectedGoods;
    this.getCredits = opts.getCredits;
    this.ensureSystemCharted = opts.ensureSystemCharted;
    this.marketTourTargets = opts.marketTourTargets;
    this.staleMarketTargets = opts.staleMarketTargets;
    this.shipyardTourTargets = opts.shipyardTourTargets;
    this.recordShipyard = opts.recordShipyard;
    this.keeperMarket = opts.keeperMarket;
    this.intentFor = opts.intentFor;
    this.shouldRun = opts.shouldRun;
    // Built last: it owns the ship state the `this.ship` accessor reads
    // through, so nothing may touch that accessor before this line.
    this.proxy = new ShipProxy(ship, {
      api: opts.api,
      registry: this.registry,
      log: this.log,
      onActivity: opts.onActivity ? (k, d, c) => opts.onActivity!(k, d, c) : undefined,
      recordMarket: opts.recordMarket,
      recordLedger: opts.recordLedger,
      repairHere: opts.repairHere,
    });
  }

  /** Read the world from the fleet's live registry instead of a private copy. */
  withRegistry(registry: Registry): this {
    this.registry = registry;
    this.proxy.setRegistry(registry);
    return this;
  }

  /** Seed positions and prices directly, for an agent with no shared registry. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[]): this {
    const standalone = this.registry as Registry & { seed?: (w: readonly WaypointPos[]) => void };
    standalone.seed?.(positions);
    this.registry.recordMarkets(markets);
    return this;
  }

  getShip(): Ship {
    return this.ship;
  }

  /**
   * Replace this agent's cached snapshot with one the fleet already fetched.
   *
   * The fleet occasionally changes a ship out from under its agent — the
   * clearest case is a critical repair, which suspends the agent, flies the
   * hull itself and repairs it. The API hands back the repaired ship, but
   * nothing used to carry it back here, so the agent's snapshot kept saying
   * condition 0.00. maybeRepairFleet() reads exactly that snapshot, so it
   * re-diverted the ship every tick and repaired it again for 0c, forever.
   * Whoever mutates a ship owns telling its agent.
   */
  adoptShip(ship: Ship): void {
    this.proxy.setShip(ship);
  }

  private async refresh(): Promise<void> {
    return this.proxy.refresh();
  }

  private async waitCooldown(): Promise<void> {
    return this.proxy.waitCooldown();
  }

  /** A short back-off that yields the scheduler instead of blocking it — the
   *  "pending cooldown, waiting…" retry paths below used to sleep 6 s in place. */
  private async pause(ms: number): Promise<void> {
    return this.proxy.pause(ms);
  }

  private async ensureInOrbit(): Promise<void> {
    return this.proxy.ensureInOrbit();
  }

  private async ensureDocked(): Promise<void> {
    return this.proxy.ensureDocked();
  }

  /** Wait until the ship has finished its current transit. */
  private async waitForArrival(): Promise<void> {
    return this.proxy.waitForArrival();
  }

  private async navigateTo(waypoint: string): Promise<void> {
    return this.proxy.navigateTo(waypoint);
  }

  private cargoFree(): number {
    return this.ship.cargo.capacity - this.ship.cargo.units;
  }

  /** True if the ship has a mining mount installed. */
  private canMine(): boolean {
    return this.ship.mounts.some((m) => m.symbol.startsWith("MOUNT_MINING_LASER"));
  }

  /** True if the ship can refine ores (a refinery/processor module is installed). */
  private canRefine(): boolean {
    return this.ship.modules.some((m) =>
      ["MODULE_ORE_REFINERY_I", "MODULE_FUEL_REFINERY_I"].includes(m.symbol),
    );
  }

  /** Best price this ship could get selling `symbol` at any reachable market, or 0. */
  private bestReachableSellPrice(symbol: string): number {
    let best = 0;
    const cap = this.ship.fuel.capacity;
    for (const m of this.registry.markets(this.ship.nav.systemSymbol)) {
      const g = m.tradeGoods[symbol];
      if (!g) continue;
      if (cap > 0 && this.estimatedFuelTo(m.symbol) > cap) continue;
      if (g.sellPrice > best) best = g.sellPrice;
    }
    return best;
  }

  /** True when refining is worth pursuing here: some ore we can mine has a refined
   *  counterpart that sells for more per unit than the raw ore at reachable markets. */
  private refineProfitable(): boolean {
    for (const [ore, produce] of Object.entries(REFINE_RECIPES)) {
      const orePrice = this.bestReachableSellPrice(ore);
      const metalPrice = this.bestReachableSellPrice(produce);
      if (orePrice > 0 && metalPrice > orePrice) return true;
    }
    return false;
  }

  /** Estimated proceeds from selling the current cargo at the best reachable
   *  price per item — used only for the pre-sale log line, so it should
   *  reflect what the ship is actually about to get, not an arbitrary quote.
   *  Previously used the price from whichever known market
   *  happened to be listed first with any quote for the good at all — often
   *  an EXPORT market (typically near-zero sellPrice, since that's where the
   *  good is already abundant), producing a misleadingly low "~0c" estimate
   *  even when the ship was about to sell for real money at the actual
   *  best-paying reachable market `pickSellTarget()` picks. */
  private cargoValue(): number {
    let total = 0;
    for (const item of this.ship.cargo.inventory) {
      total += this.bestReachableSellPrice(item.symbol) * item.units;
    }
    return total;
  }

  /** Pick the nearest mining target the ship can reach and return from. */
  private pickMiningTarget(): WaypointPos | undefined {
    // An operator-pinned field wins over the ship's own choice — but only if we
    // actually know where it is. A pin to an unknown waypoint falls through to
    // the normal pick rather than stranding the ship on a target it can't plot.
    if (this.pinnedMiningTarget) {
      const pinned = this.registry.position(this.pinnedMiningTarget);
      if (pinned) return pinned;
      this.log(`pinned field ${this.pinnedMiningTarget} is not in the atlas; picking the nearest instead`);
    }
    // If we're parked at a market, we can refuel before leaving — budget a full tank.
    const atMarket = this.atMarketHere();
    const fuelBudget =
      this.ship.fuel.capacity > 0 ? (atMarket ? this.ship.fuel.capacity : this.ship.fuel.current) : 0;
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of this.registry.waypointsIn(this.ship.nav.systemSymbol)) {
      if (wp.type !== "ASTEROID_FIELD" && wp.type !== "ASTEROID" && wp.type !== "ENGINEERED_ASTEROID") continue;
      const dist = this.distanceTo(wp);
      if (dist >= bestDist) continue;
      if (this.ship.fuel.capacity > 0) {
        // Prefer targets reachable round-trip, but allow one-way trips if the ship can
        // reach the asteroid AND there is a market reachable from it to refuel at.
        const roundTrip = this.fuelNeededRoundTrip(wp.symbol);
        if (roundTrip <= fuelBudget) {
          // full round-trip is fine
        } else {
          const out = this.estimatedFuelTo(wp.symbol);
          if (out > fuelBudget) continue; // can't even get there
          const refuelFromAsteroid = this.nearestMarketTo(wp.symbol);
          if (!refuelFromAsteroid) continue; // no way to refuel after mining
          const back = this.estimatedFuelToBetween(wp.symbol, refuelFromAsteroid);
          if (out + back > fuelBudget) continue; // can't reach asteroid + nearest market
        }
      }
      bestDist = dist;
      best = wp;
    }
    return best;
  }

  /** Nearest market (reachable with current fuel) from which some asteroid is minable, if any. */
  private async pickRelocationTarget(): Promise<string | undefined> {
    if (this.ship.fuel.capacity <= 0) return undefined;
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.registry.marketEndpoints(this.ship.nav.systemSymbol)) {
      if (m.symbol === this.ship.nav.waypointSymbol) continue;
      const d = this.estimatedFuelTo(m.symbol);
      if (d > this.ship.fuel.current) continue; // can't reach it now
      const mineableFromThere = this.registry.waypointsIn(this.ship.nav.systemSymbol).some(
        (wp) =>
          (wp.type === "ASTEROID_FIELD" || wp.type === "ASTEROID" || wp.type === "ENGINEERED_ASTEROID") &&
          this.fuelNeededRoundTripFrom(m.symbol, wp.symbol) <= this.ship.fuel.capacity,
      );
      if (!mineableFromThere) continue;
      if (d < bestDist) {
        bestDist = d;
        best = m.symbol;
      }
    }
    return best;
  }

  /** Round-trip fuel from an arbitrary market to a target and back to its nearest market. */
  private fuelNeededRoundTripFrom(market: string, target: string): number {
    const out = this.estimatedFuelToBetween(market, target);
    const nearest = this.nearestMarketTo(target);
    const back = nearest ? this.estimatedFuelToBetween(target, nearest) : out;
    return out + back + 5;
  }

  private distanceTo(wp: WaypointPos): number {
    return this.registry.distance(this.ship.nav.waypointSymbol, wp.symbol);
  }

  /**
   * Reachable markets that will actually buy `goodSymbol`, best price first.
   *
   * "Will buy" is the market listing it as an import or exchange. A market
   * that does not list a good rejects the sale outright — "Trade good
   * SILICON_CRYSTALS is not listed at market X1-S84-H56" — so a target
   * chosen without this check is a wasted trip at best.
   */
  private sellMarketsFor(goodSymbol: string): MarketSnapshot[] {
    const fuelCap = this.ship.fuel.capacity;
    return this.registry
      .markets(this.ship.nav.systemSymbol)
      .filter((m) => {
        if (m.imports.includes(goodSymbol) || m.exchange.includes(goodSymbol)) return true;
        const g = m.tradeGoods[goodSymbol];
        return g && (g.type === "IMPORT" || g.type === "EXCHANGE");
      })
      // Never chase a market the ship cannot reach even on a full tank (e.g.
      // ore importer B7 at 303 fuel vs an 80-tank ship) — that just loops on
      // "cannot navigate". Same-system, with a known position, for the same
      // reason nearestReachableMarket() requires both: cross-system distances
      // are not comparable, and a missing position silently reads as 0 fuel
      // away, so the least reachable candidates score best.
      .filter(
        (m) =>
          this.registry.position(m.symbol) !== undefined &&
          (fuelCap <= 0 || this.estimatedFuelTo(m.symbol) <= fuelCap),
      )
      // Rank by sellPrice — what this market pays the ship for the good — not
      // purchasePrice, which is what buying FROM that market would cost and has
      // no bearing on a sell decision. Sorting by purchasePrice here picked
      // whichever reachable market was most expensive to buy from, which can
      // easily be a market that pays poorly to sell to; that produced real
      // near-zero-proceeds sales (a market with a high purchasePrice but a low
      // sellPrice looked "best" and won the sort, when it was actually one of
      // the worst places to sell).
      .sort((a, b) => (b.tradeGoods[goodSymbol]?.sellPrice ?? 0) - (a.tradeGoods[goodSymbol]?.sellPrice ?? 0));
  }

  /**
   * Choose a selling destination, considering everything in the hold.
   *
   * This used to read `inventory[0]` and give up if that one good had no
   * buyer, which is how four miners bricked themselves. A mining ship
   * extracts whatever the asteroid yields — at X1-S84-EC5D that was iron,
   * copper and aluminium ore (all sellable at H56) mixed with quartz sand,
   * ice water and silicon crystals (none of them listed there). The
   * unsellable half stayed aboard after every trip, and once it reached the
   * front of the inventory the ship stopped recognising that it was still
   * carrying 10u of sellable ore behind it. Sales decayed 12 → 9 → 5 → 1 → 0
   * and all four sat at a full hold for ninety-five minutes.
   *
   * Ranking by proceeds (price × units) rather than unit price, because the
   * point is to empty the hold profitably, not to get the best price on one
   * unit of whatever happens to be aboard.
   */
  private pickSellTarget(): string | undefined {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    let best: { market: string; proceeds: number } | undefined;
    for (const item of this.ship.cargo.inventory) {
      if (protectedGoods.has(item.symbol)) continue;
      const market = this.sellMarketsFor(item.symbol)[0];
      if (!market) continue;
      const proceeds = (market.tradeGoods[item.symbol]?.sellPrice ?? 0) * item.units;
      if (!best || proceeds > best.proceeds) best = { market: market.symbol, proceeds };
    }
    return best?.market;
  }

  /** Held goods, excluding reserved ones, that no reachable market will buy. */
  private unsellableGoods(): { symbol: string; units: number }[] {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    return this.ship.cargo.inventory
      .filter((i) => !protectedGoods.has(i.symbol) && this.sellMarketsFor(i.symbol).length === 0)
      .map((i) => ({ symbol: i.symbol, units: i.units }));
  }

  /**
   * Throw away cargo nothing in range will buy, once it is crowding the hold.
   *
   * The deadlock this ends: a good with no reachable buyer occupies its slot
   * forever. Mining adds more of it every trip, and there is no other exit —
   * the miner has no equivalent of the trader's clearLeftoverCargo(), so the
   * hold fills with material the fleet cannot convert to anything and the
   * ship mines into a full hold indefinitely.
   *
   * Deliberately not on first rejection: a market's listings change, and a
   * few units riding along cost nothing while there is still room to mine.
   * The threshold is where the cargo stops being free to carry.
   *
   * Never touches protectedGoods — contract and mission cargo is reserved
   * precisely because no market for it is the normal case, and jettisoning
   * it would destroy the delivery the fleet is being paid for.
   *
   * Jettison is the crude version of the right answer. When warehouse ships
   * can hold material for a later cross-system run, this becomes "haul it
   * there" instead of "destroy it" — see docs/control-plane-data-plane.md §10.
   */
  private async dumpUnsellableCargo(): Promise<boolean> {
    const capacity = this.ship.cargo.capacity;
    if (capacity <= 0 || this.ship.cargo.units < capacity * 0.8) return false;
    const dead = this.unsellableGoods();
    if (dead.length === 0) return false;
    for (const item of dead) {
      try {
        this.currentStep = { kind: "transacting", action: "jettison", good: item.symbol };
        await this.api.jettisonCargo(this.symbol, item.symbol, item.units);
        this.currentStep = IDLE_STEP;
        this.log(`jettisoned ${item.units}u ${item.symbol}: no reachable market buys it`);
        this.onActivity?.("jettison", `${item.units}u ${item.symbol} (no buyer in range)`, undefined, this.symbol);
      } catch (err) {
        this.currentStep = IDLE_STEP;
        this.log(`jettison failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.refresh();
    return true;
  }

  /** Dock at a market waypoint and refresh its price snapshot. */
  private async observeMarket(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    // The waypoint's own system, not this agent's construction-time one — a
    // ship that has jumped would otherwise ask for a foreign waypoint under
    // its home system and get a 404.
    const systemSymbol = this.registry.systemOf(waypoint);
    const market = await this.api.getMarket(systemSymbol, waypoint);
    const snapshot = this.registry.market(waypoint) ?? {
      symbol: waypoint,
      systemSymbol,
      tradeGoods: {},
      imports: (market.imports ?? []).map((g) => g.symbol),
      exports: (market.exports ?? []).map((g) => g.symbol),
      exchange: (market.exchange ?? []).map((g) => g.symbol),
      fetchedAt: new Date().toISOString(),
    };
    for (const g of market.tradeGoods ?? []) {
      snapshot.tradeGoods[g.symbol] = g;
    }
    snapshot.fetchedAt = new Date().toISOString();
    this.registry.recordMarket(snapshot);
  }

  /** Tour unvisited markets to build the price table. Returns true if a tour happened. */
  private async discoverMarkets(): Promise<boolean> {
    const here = this.ship.nav.waypointSymbol;
    const candidates = this.registry
      .markets(this.ship.nav.systemSymbol)
      .filter((m) => Object.keys(m.tradeGoods).length === 0)
      .filter((m) => this.ship.fuel.capacity <= 0 || this.fuelNeededRoundTrip(m.symbol) <= this.ship.fuel.capacity)
      .sort((a, b) => this.registry.distance(here, a.symbol) - this.registry.distance(here, b.symbol));
    const target = candidates[0];
    if (!target) return false;
    this.log(`discovering market at ${target.symbol}`);
    await this.refuelIfNeeded(5, target.symbol);
    await this.observeMarket(target.symbol);
    return true;
  }

  private estimatedFuelTo(waypoint: string): number {
    return this.registry.fuelFor(this.ship.nav.waypointSymbol, waypoint);
  }

  /** Estimate the fuel needed to reach a target and return to the nearest market, with reserve. */
  private fuelNeededRoundTrip(target: string): number {
    const here = this.ship.nav.waypointSymbol;
    const nearestMarket = this.nearestMarketTo(target);
    const out = this.estimatedFuelTo(target);
    const back = nearestMarket ? this.estimatedFuelToBetween(target, nearestMarket) : out;
    return out + back + 5;
  }

  private nearestMarketTo(waypoint: string): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    // marketEndpoints() is already scoped to one system, which is what this
    // needs: it feeds fuelNeededRoundTrip(), and a "nearest" market a jump
    // away is not somewhere the return leg can reach.
    for (const m of this.registry.marketEndpoints(this.systemOfWaypoint(waypoint))) {
      const d = this.estimatedFuelToBetween(waypoint, m.symbol);
      if (d < bestDist) {
        bestDist = d;
        best = m.symbol;
      }
    }
    return best;
  }

  private estimatedFuelToBetween(a: string, b: string): number {
    return this.registry.fuelFor(a, b);
  }

  /** Find the nearest market in this system the ship can reach with current fuel. */
  private nearestReachableMarket(): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    // Scoped to this system by marketEndpoints(), and every entry it returns
    // has a real position. Both used to be hand-checked here: a market a jump
    // away produced "Destination X1-KU72-I60 is outside the X1-TP98 system"
    // once per tick indefinitely, and a market with no position read as zero
    // fuel away and won outright.
    for (const m of this.registry.marketEndpoints(this.ship.nav.systemSymbol)) {
      const need = this.estimatedFuelTo(m.symbol);
      if (need > this.ship.fuel.current) continue;
      if (need < bestDist) {
        bestDist = need;
        best = m.symbol;
      }
    }
    return best;
  }

  /** System half of a waypoint symbol (X1-TP98-A14X -> X1-TP98). */
  /**
   * Whether the ship is standing at somewhere it can trade or refuel. The
   * trait is the authority (a fuel station nobody has priced is still a
   * pump — DAGGER-13 sat on one at 27/300 reporting itself stranded), with
   * a recorded snapshot as the fallback for a world seeded from plain
   * coordinates, and the injected callback kept for callers that still
   * supply one.
   */
  private atMarketHere(): boolean {
    const here = this.ship.nav.waypointSymbol;
    return this.registry.isMarket(here) || this.registry.market(here) !== undefined;
  }

  private systemOfWaypoint(waypointSymbol: string): string {
    return this.registry.systemOf(waypointSymbol);
  }

  private async refuelIfNeeded(reserve: number, target?: string): Promise<boolean> {
    return this.proxy.refuelIfNeeded({ reserve, target });
  }

  /** Find the best arbitrage route starting from a given (or current) market. */
  private findArbitrageRouteFrom(origin?: string): {
    good: string;
    buyAt: string;
    sellAt: string;
    buyPrice: number;
    sellPrice: number;
    units: number;
    profit: number;
  } | undefined {
    const here = origin ?? this.ship.nav.waypointSymbol;
    const buyMarket = this.registry.market(here);
    if (!buyMarket || Object.keys(buyMarket.tradeGoods).length === 0) return undefined;
    let best: ReturnType<typeof this.findArbitrageRouteFrom> | undefined;
    for (const [good, buy] of Object.entries(buyMarket.tradeGoods)) {
      for (const sellMarket of this.registry.markets(this.systemOfWaypoint(here))) {
        if (sellMarket.symbol === here) continue;
        const sell = sellMarket.tradeGoods[good];
        if (!sell) continue;
        const margin = sell.sellPrice - buy.purchasePrice;
        if (margin <= 2) continue;
        const fuelToSell = this.estimatedFuelToBetween(here, sellMarket.symbol);
        // Assume we can refuel at the origin market before leaving.
        if (this.ship.fuel.capacity > 0 && fuelToSell > this.ship.fuel.capacity - 5) continue;
        const credits = this.getCredits?.() ?? Infinity;
        const affordable = credits > 0 && buy.purchasePrice > 0 ? Math.floor(credits / buy.purchasePrice) : Infinity;
        const units = Math.min(buy.tradeVolume, sell.tradeVolume, this.ship.cargo.capacity, affordable);
        if (units <= 0) continue;
        const fuelCost = fuelToSell * (this.priceTableFuel(here) ?? 72);
        const profit = margin * units - fuelCost;
        if (profit <= 50) continue;
        if (!best || profit > best.profit) {
          best = { good, buyAt: here, sellAt: sellMarket.symbol, buyPrice: buy.purchasePrice, sellPrice: sell.sellPrice, units, profit };
        }
      }
    }
    return best;
  }

  private priceTableFuel(waypoint: string): number | undefined {
    return this.registry.market(waypoint)?.tradeGoods["FUEL"]?.purchasePrice;
  }

  /** Buy a good at the current market and fly to sell elsewhere. */
  private async executeArbitrage(route: NonNullable<ReturnType<typeof this.findArbitrageRouteFrom>>): Promise<boolean> {
    await this.ensureDocked();
    await this.refuelIfNeeded(5, route.sellAt);
    const units = Math.min(route.units, this.cargoFree());
    if (units <= 0) return false;
    this.log(`arbitrage: buying ${units}u ${route.good} @ ${route.buyPrice}c`);
    this.currentStep = { kind: "transacting", action: "buy", good: route.good };
    // Rule 5. Same straight-line shape, and the same exposure, as the
    // trader's runArbitrage(): buy, navigate, sell with nothing re-checking
    // position between the statements. The trader lost 9,036c a cycle to
    // exactly this before its own assertAt went in.
    this.proxy.assertAt(route.buyAt, `buy ${route.good}`);
    const bought = await this.api.purchaseCargo(this.symbol, route.good, units);
    this.currentStep = IDLE_STEP;
    this.ship = { ...this.ship, cargo: bought.cargo };
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: route.good,
      units,
      pricePerUnit: bought.transaction.pricePerUnit,
      total: bought.transaction.totalPrice,
    });
    this.onActivity?.("buy", `${units}u ${route.good} @ ${bought.transaction.pricePerUnit}c at ${route.buyAt}`, -bought.transaction.totalPrice, this.symbol);
    await this.navigateTo(route.sellAt);
    await this.ensureDocked();
    this.currentStep = { kind: "transacting", action: "sell", good: route.good };
    // The leg that carries the loss: the navigate above is the one most
    // likely to have not arrived, and selling here anyway dumps the cargo at
    // the buy market for less than it cost.
    this.proxy.assertAt(route.sellAt, `sell ${route.good}`);
    const sold = await this.api.sellCargo(this.symbol, route.good, units);
    this.currentStep = IDLE_STEP;
    this.ship = { ...this.ship, cargo: sold.cargo };
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "SELL",
      tradeSymbol: route.good,
      units,
      pricePerUnit: sold.transaction.pricePerUnit,
      total: sold.transaction.totalPrice,
    });
    const gain = sold.transaction.totalPrice - bought.transaction.totalPrice;
    this.log(`arbitrage: sold ${units}u ${route.good} @ ${sold.transaction.pricePerUnit}c (gain ${gain}c)`);
    this.onActivity?.("sell", `${units}u ${route.good} @ ${sold.transaction.pricePerUnit}c at ${route.sellAt}`, sold.transaction.totalPrice, this.symbol);
    return true;
  }
  async tick(): Promise<boolean> {
    // A goal this ship executes rather than stands down on — step 5. The
    // repair controller proposes and never touches the hull, so the
    // two-owners race it used to create cannot happen.
    const repairIntent = this.intentFor?.();
    if (repairIntent?.goal.kind === "repair") {
      return this.proxy.runRepairGoal(repairIntent, () => this.intentFor?.());
    }
    // Step 4: an operator hold is a goal this ship flies, not a private flag
    // the fleet sets while flying the hull itself. See ShipProxy.runHoldGoal.
    if (repairIntent?.goal.kind === "hold" && repairIntent.goal.waypoint) {
      return this.proxy.runHoldGoal(repairIntent, () => this.intentFor?.());
    }

    // The fleet itself is driving this hull (repair, fuel ferry, operator
    // hold), so acting here is the two-owners race that had a diverter and a
    // tour agent alternately flying the same ship every few seconds for a
    // day. Stand down until the intent changes.
    const standDown = standDownReason(this.intentFor?.());
    if (standDown) {
      this.log(`standing down, fleet is driving this ship: ${standDown}`);
      return false;
    }

    if (this.suspended) {
      this.log("suspended: holding position");
      return false;
    }
    await this.refresh();
    await this.waitCooldown();

    // If the ship is stranded (no fuel and not at a market), it can't act.
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current <= 0 && !this.atMarketHere()) {
      this.log(`stranded at ${this.ship.nav.waypointSymbol} (0 fuel, no market); idling`);
      return false;
    }

    // Top up fuel whenever docked at a market and below a safe threshold.
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current < this.ship.fuel.capacity * 0.5) {
      const atMarket = this.atMarketHere();
      if (atMarket) {
        await this.ensureDocked();
        this.log(`refueling (${this.ship.fuel.current}/${this.ship.fuel.capacity})`);
        const res = await this.api.refuelShip(this.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: this.symbol,
          waypointSymbol: this.ship.nav.waypointSymbol,
          type: "REFUEL",
          units: res.fuel.current,
          total: res.transaction.totalPrice,
        });
        await this.refresh();
      }
    }

    const cargoFree = this.cargoFree();
    const cargoValue = this.cargoValue();

    // An extraction session interrupted by its own cooldown (CooldownPending)
    // resumes here with a part-filled hold. Keep mining rather than treating
    // those few units as a cargo to deliver or sell — see miningSession.
    if (this.miningSession !== null && (this.miningSession !== this.ship.nav.waypointSymbol || this.ship.nav.status === "IN_TRANSIT")) {
      this.miningSession = null;
    }
    const midMining = this.miningSession !== null && cargoFree > 0 && this.canMine();

    // 1. If cargo is held for a contract delivery, route it first.
    if (!midMining && this.ship.cargo.units > 0 && this.deliverCargo) {
      const result = await this.deliverCargo(this.ship);
      if (typeof result === "string") {
        this.log(`delivering cargo → ${result}`);
        const canRefuel = await this.refuelIfNeeded(5, result);
        if (!canRefuel) {
          this.log(`delivery to ${result} impossible: not enough fuel and no reachable refuel stop`);
          return false;
        }
        await this.navigateTo(result);
        await this.ensureDocked();
        await this.deliverCargo(this.ship);
        await this.refresh();
        return true;
      }
      if (result === true) {
        await this.refresh();
        return true;
      }
    }

    // 2. Otherwise sell any remaining cargo.
    if (!midMining && this.ship.cargo.units > 0) {
      const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
      const sellable = this.ship.cargo.inventory.filter((i) => !protectedGoods.has(i.symbol));
      if (sellable.length > 0) {
        const target = this.pickSellTarget();
        if (target) {
          await this.refuelIfNeeded(5, target);
          this.log(`selling ${sellable.length} saleable cargo worth ~${cargoValue}c`);
          await this.navigateTo(target);
          await this.ensureDocked();
          await this.sellAllCargo(target);
          await this.refresh();
          return true;
        }
        // Cargo full but no known buyer: tour markets to discover prices.
        if (this.ship.cargo.units >= this.ship.cargo.capacity * 0.8) {
          const toured = await this.discoverMarkets();
          if (toured) return true;
          // Nowhere left to look and nowhere to sell. Anything with no
          // reachable buyer goes overboard, or the hold stays full and this
          // ship mines into it forever — the state four DRAGOM miners were
          // in for ninety-five minutes.
          if (await this.dumpUnsellableCargo()) return true;
        }
      }
    }

    // 3. After selling, if empty at a market, run a quick arbitrage route.
    if (!midMining && this.ship.cargo.units === 0) {
      const route = this.findArbitrageRouteFrom();
      if (route) {
        this.log(`arbitrage opportunity: ${route.good} ${route.buyAt} → ${route.sellAt}, +${route.profit}c`);
        await this.executeArbitrage(route);
        return true;
      }
    }

    // 4. Otherwise mine.
    if (!this.canMine()) {
      this.goal = { kind: "idle" };
      this.log("no mining mount; idling");
      return false;
    }
    const target = this.pickMiningTarget();
    if (!target) {
      // No asteroid reachable from here. If we're parked at a market with fuel,
      // relocate to a market that has a minable asteroid within round-trip range.
      const relocate = await this.pickRelocationTarget();
      if (relocate) {
        this.log(`relocating to ${relocate}: no asteroids in range from ${this.ship.nav.waypointSymbol}`);
        await this.refuelIfNeeded(5, relocate);
        await this.navigateTo(relocate);
        return true;
      }
      this.goal = { kind: "idle" };
      this.log("no mining target found");
      return false;
    }
    await this.refuelIfNeeded(5, target.symbol);
    this.log(`mining at ${target.symbol}`);
    await this.navigateTo(target.symbol);
    await this.ensureInOrbit();
    if (this.canRefine() && (this.hasSurveyor() || this.refineProfitable())) {
      await this.mineAndRefine();
    } else {
      await this.extractUntilFull();
    }
    await this.refresh();
    return true;
  }

  /**
   * Mine ore and refine it in-orbit, packing the hold with processed metal.
   * Each 10:1 refine frees 9 cargo slots that we refill by mining again, so a
   * trip carries ~10x the value per slot. When a surveyor mount is installed,
   * surveys the asteroid first and extracts the refinable deposit so a single
   * ore accumulates to 10+ units. Stops when the hold is full of
   * non-refinable cargo (or the loop safety cap is hit).
   */
  private async mineAndRefine(): Promise<void> {
    let safety = 0;
    this.miningSession = this.ship.nav.waypointSymbol;
    let survey = this.cachedSurvey();
    if (!survey && this.hasSurveyor()) {
      survey = await this.createAndPickSurvey();
    } else if (!survey && this.surveyPool) {
      survey = this.surveyPool.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
      if (survey) this.log(`using shared survey at ${this.ship.nav.waypointSymbol}`);
    }
    this.rememberSurvey(survey);
    while (safety < 60 && this.running) {
      safety += 1;
      // Refine a full batch of ore first (frees room), then mine to refill.
      const target = this.ship.cargo.inventory.find((i) => (REFINE_RECIPES[i.symbol] ?? "") && i.units >= 10);
      if (target) {
        const produce = REFINE_RECIPES[target.symbol]!;
        try {
          this.log(`refining ${target.units}u ${target.symbol} → ${produce}`);
          const res = await this.api.refine(this.symbol, produce);
          this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
          const made = res.produced[0];
          const used = res.consumed[0];
          this.onActivity?.(
            "refine",
            `+${made?.units ?? 0}u ${made?.tradeSymbol ?? "?"} (from ${used?.units ?? 0}u ${used?.tradeSymbol ?? "?"}) (${this.ship.cargo.units}/${this.ship.cargo.capacity})`,
            undefined,
            this.symbol,
          );
          await this.waitCooldown();
        } catch (err) {
          if (err instanceof Pending) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cooldown")) {
            this.log(`refine pending cooldown, waiting…`);
            await this.pause(6_000);
            continue;
          }
          this.log(`refine failed: ${msg}`);
          this.miningSession = null;
          return;
        }
        continue;
      }
      // Nothing left to refine: mine until the hold is full.
      if (this.cargoFree() === 0) {
        this.miningSession = null;
        return;
      }
      try {
        let res: {
          cooldown: components["schemas"]["Cooldown"];
          extraction: components["schemas"]["Extraction"];
          cargo: components["schemas"]["ShipCargo"];
        };
        this.currentStep = { kind: "transacting", action: "extract" };
        if (survey) {
          res = await this.api.extractWithSurvey(this.symbol, survey);
        } else {
          res = await this.api.extract(this.symbol);
        }
        this.currentStep = IDLE_STEP;
        this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
        const got = res.extraction.yield;
        this.onActivity?.("extract", `+${got.units}u ${got.symbol} (${this.ship.cargo.units}/${this.ship.cargo.capacity})`, undefined, this.symbol);
        this.log(`extracted ${got.units}u ${got.symbol}`);
        await this.waitCooldown();
      } catch (err) {
        if (err instanceof Pending) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cooldown")) {
          this.log(`extract pending cooldown, waiting…`);
          await this.pause(6_000);
          continue;
        }
        if (survey && /exhaust|expire|signature|invalid/i.test(msg)) {
          this.log(`survey no longer usable: ${msg}; re-surveying`);
          this.surveyPool?.invalidate(this.ship.nav.waypointSymbol, survey.signature);
          survey = this.hasSurveyor()
            ? await this.createAndPickSurvey()
            : this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
          this.rememberSurvey(survey);
          if (survey) continue;
          this.log("no usable survey; falling back to plain extraction");
        }
        this.log(`extract failed: ${msg}`);
        this.miningSession = null;
        return;
      }
    }
    this.miningSession = null;
    if (safety >= 60) this.log("mineAndRefine hit safety cap");
  }

  /** The session's survey, if it is for this waypoint and still valid. */
  private cachedSurvey(): components["schemas"]["Survey"] | undefined {
    const c = this.activeSurvey;
    if (!c) return undefined;
    if (c.waypoint !== this.ship.nav.waypointSymbol || new Date(c.survey.expiration).getTime() <= Date.now()) {
      this.activeSurvey = undefined;
      return undefined;
    }
    return c.survey;
  }

  private rememberSurvey(survey: components["schemas"]["Survey"] | undefined): void {
    this.activeSurvey = survey ? { waypoint: this.ship.nav.waypointSymbol, survey } : undefined;
  }

  /** True if the ship has a surveyor mount installed. */
  private hasSurveyor(): boolean {
    return this.ship.mounts.some((m) => m.symbol.startsWith("MOUNT_SURVEYOR"));
  }

  /** Survey the current waypoint and pick the deposit that refines into the most valuable metal. */
  private async createAndPickSurvey(): Promise<components["schemas"]["Survey"] | undefined> {
    try {
      this.currentStep = { kind: "transacting", action: "survey" };
      const res = await this.api.createSurvey(this.symbol);
      this.currentStep = IDLE_STEP;
      this.ship = { ...this.ship, cooldown: res.cooldown };
      // The cooldown wait comes *after* the pick is made and remembered: under
      // the scheduler waitCooldown() ends the tick, and a survey we had already
      // paid for would otherwise be thrown away with it.
      let best: components["schemas"]["Survey"] | undefined;
      let bestPrice = 0;
      let anyRefinable: components["schemas"]["Survey"] | undefined;
      for (const s of res.surveys) {
        for (const d of s.deposits) {
          const produce = REFINE_RECIPES[d.symbol];
          if (!produce) continue;
          anyRefinable ??= s;
          const price = this.bestReachableSellPrice(produce);
          if (price > bestPrice) {
            bestPrice = price;
            best = s;
          }
        }
      }
      best ??= anyRefinable;
      // Deposit the survey in the shared pool so non-surveyor miners can use it too.
      this.surveyPool?.record(this.ship.nav.waypointSymbol, ...res.surveys);
      this.log(
        best
          ? `survey: ${best.deposits.map((d) => d.symbol).join(",")} (${best.size}, exp ${new Date(best.expiration).toISOString().slice(11, 16)})`
          : `survey: no refinable deposits (${res.surveys.map((s) => s.deposits.map((d) => d.symbol).join(",")).join(" | ")})`,
      );
      this.rememberSurvey(best);
      await this.waitCooldown();
      return best;
    } catch (err) {
      if (err instanceof Pending) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cooldown")) {
        this.log(`survey pending cooldown, waiting…`);
        await this.pause(6_000);
        return undefined;
      }
      this.log(`survey failed: ${msg}`);
      return undefined;
    }
  }

  /**
   * Surveyor scout: fly between asteroid fields surveying each and depositing
   * the surveys into the shared pool for the mining fleet. The ship must have a
   * surveyor mount; it does not need a mining laser or cargo capacity.
   */
  async surveyScout(): Promise<boolean> {
    // The fleet itself is driving this hull (repair, fuel ferry, operator
    // hold), so acting here is the two-owners race that had a diverter and a
    // tour agent alternately flying the same ship every few seconds for a
    // day. Stand down until the intent changes.
    const standDown = standDownReason(this.intentFor?.());
    if (standDown) {
      this.log(`standing down, fleet is driving this ship: ${standDown}`);
      return false;
    }

    if (this.suspended) {
      this.log("survey scout: suspended, holding");
      return false;
    }
    await this.refresh();
    await this.waitCooldown();
    this.log(`survey scout: tick @ ${this.ship.nav.waypointSymbol} (fuel ${this.ship.fuel.current}/${this.ship.fuel.capacity})`);

    // Priority 1: actually survey asteroid fields so miners have deposits to use.
    // Market/shipyard tours are secondary intel work.
    const target = this.pickSurveyTarget();
    if (target) {
      await this.refuelIfNeeded(5, target.symbol);
      this.log(`survey scout: surveying ${target.symbol}`);
      await this.navigateTo(target.symbol);
      await this.ensureInOrbit();
      const survey = await this.createAndPickSurvey();
      if (survey) {
        this.surveyedFields.add(target.symbol);
        this.onActivity?.("survey", `deposited ${survey.deposits.map((d) => d.symbol).join(",")} at ${target.symbol}`, undefined, this.symbol);
      }
      return true;
    }

    // No asteroid field needs a survey right now: do intel tours instead.
    // Periodically tour marketplaces so price snapshots stay fresh and we catch
    // new goods (e.g. modules) as market inventory rotates. One market per tick.
    const tourTargets = (await this.marketTourTargets?.()) ?? [];
    if (tourTargets.length > 0) {
      const marketTarget = tourTargets[this.marketTourIndex % tourTargets.length];
      if (marketTarget && marketTarget !== this.ship.nav.waypointSymbol) {
        await this.refuelIfNeeded(5, marketTarget);
        this.log(`survey scout: touring market ${marketTarget}`);
        await this.observeMarket(marketTarget);
        this.marketTourIndex += 1;
        return true;
      }
      this.marketTourIndex += 1;
    }

    // Periodically tour shipyards so their stock stays fresh (ship inventory is
    // only visible when a ship is docked there). One shipyard per tick.
    const yardTargets = (await this.shipyardTourTargets?.()) ?? [];
    if (yardTargets.length > 0) {
      const yardTarget = yardTargets[this.marketTourIndex % yardTargets.length];
      if (yardTarget && yardTarget !== this.ship.nav.waypointSymbol) {
        await this.refuelIfNeeded(5, yardTarget);
        this.log(`survey scout: touring shipyard ${yardTarget}`);
        await this.navigateTo(yardTarget);
        await this.ensureDocked();
        if (this.recordShipyard) await this.recordShipyard(yardTarget);
        this.marketTourIndex += 1;
        return true;
      }
      this.marketTourIndex += 1;
    }

    this.goal = { kind: "idle" };
    this.log("survey scout: no survey target found");
    return false;
  }

  /**
   * Tour scout: fly between marketplaces and shipyards, docking at each to keep
   * price snapshots and ship-stock intel fresh. No cargo, no mining, no surveyor
   * mount required — just navigation + docking. One target per tick.
   */
  async tourScout(): Promise<boolean> {
    // The fleet itself is driving this hull (repair, fuel ferry, operator
    // hold), so acting here is the two-owners race that had a diverter and a
    // tour agent alternately flying the same ship every few seconds for a
    // day. Stand down until the intent changes.
    const standDown = standDownReason(this.intentFor?.());
    if (standDown) {
      this.log(`standing down, fleet is driving this ship: ${standDown}`);
      return false;
    }

    if (this.suspended) {
      this.log("tour scout: suspended, holding");
      return false;
    }
    await this.refresh();
    // The operator moving a ship somewhere and expecting the tour loop not to
    // yank it off to the next market used to be handled here, off a private
    // manualGoal. It is handled at the top of this tick now, off the hold
    // intent — one owner, decided in one place.
    this.log(`tour scout: tick @ ${this.ship.nav.waypointSymbol} (fuel ${this.ship.fuel.current}/${this.ship.fuel.capacity})`);

    // Finish the previous leg before choosing a new one.
    //
    // navigateTo() raises NavigationPending the moment the ship enters transit,
    // and in the scheduler-driven path (production) that unwinds this method —
    // so the ensureDocked()/recordMarket() that follow the navigate below never
    // run. The scout arrives, tourScout() starts fresh, and `t !== here` filters
    // out the very market it just flew to, so it picks another and leaves.
    //
    // The result is a tour that never tours: two scouts circled inside X1-TP98
    // and X1-RD37 for seven and a half hours and recorded zero prices between
    // them. Home markets only have data because keepers sit docked at them.
    // It also drives the ping-pong — a market that is never recorded never
    // stops being the stalest, so the pair trade places forever.
    const standingAt = this.ship.nav.waypointSymbol;
    if (this.registry.isMarket(standingAt) || this.registry.market(standingAt) !== undefined) {
      await this.ensureDocked();
      if (this.recordMarket) await this.recordMarket(standingAt);
    }

    const marketTargets = (await this.marketTourTargets?.()) ?? [];
    const yardTargets = (await this.shipyardTourTargets?.()) ?? [];
    const targets = [...marketTargets, ...yardTargets];
    if (targets.length === 0) {
      this.log("tour scout: no tour targets");
      return false;
    }
    // Prefer markets whose snapshots have gone stale — that's the whole point
    // of the tour. Fall back to nearest-reachable when everything is fresh.
    const stale = new Set((await this.staleMarketTargets?.()) ?? []);
    const here = this.ship.nav.waypointSymbol;
    // No coordinates for the waypoint we are physically standing on means this
    // agent's position cache predates the system it now sits in — every `dist`
    // below would come out Infinity and the scout would report "no reachable
    // target" against a full target list, forever, without ever moving. Seen
    // live: after a restart, three scouts parked in systems explored earlier in
    // the session sat blind at 26 known targets each while the one scout still
    // in the home system toured normally. Chart it and re-read before deciding.
    if (this.registry.position(here) === undefined) {
      await this.ensureSystemCharted?.(this.ship.nav.systemSymbol);
    }
    const reachable = targets
      .filter((t) => t !== here)
      // Same system only. Waypoint coordinates are per-system, so the distance
      // below is meaningless across systems — it can land under fuel capacity
      // purely by coincidence and send the ship at a waypoint it cannot reach
      // without a jump. Previously this was masked: the position cache held
      // only the home system, so anything else fell out as Infinity. Now that
      // the cache is repaired above, the guard has to be explicit.
      .filter((t) => t.slice(0, t.lastIndexOf("-")) === this.ship.nav.systemSymbol)
      .map((t) => ({ t, dist: this.registry.fuelFor(here, t), stale: stale.has(t) }))
      // Outbound *and* a way back out. Filtering on the one-way leg alone let
      // scouts fly to the edge of a system and strand: DAGGER-15 reached
      // X1-TV75-D19B, from which the system's only other markets sit 467 and
      // 659 units away against a 300 tank, and correctly reported "no
      // reachable target" from then on. fuelNeededRoundTrip() is the same
      // check refuelIfNeeded() already makes — it was just being made after
      // the target was chosen instead of while choosing it.
      .filter((x) => x.dist <= this.ship.fuel.capacity && this.fuelNeededRoundTrip(x.t) <= this.ship.fuel.capacity)
      .sort((a, b) => Number(b.stale) - Number(a.stale) || a.dist - b.dist);
    const target = reachable[0]?.t;
    if (!target) {
      // Refuelling is decided after a target is chosen, so a ship with an empty
      // tank — the one that most needs fuel — returns here every tick and never
      // reaches refuelIfNeeded() at all. Its range is what made every target
      // unreachable in the first place. DAGGER-15 sat at 0/300 on
      // X1-RD37-BB4D, which is itself a marketplace, doing exactly this.
      // Top up where we stand, then let the next tick re-evaluate with a real
      // range. Only reports work done if the tank actually gained fuel, so a
      // market that sells none can't turn this into a spin.
      const lowFuel = this.ship.fuel.capacity > 0 && this.ship.fuel.current < this.ship.fuel.capacity * 0.9;
      if (lowFuel && this.atMarketHere()) {
        const before = this.ship.fuel.current;
        await this.refuelIfNeeded(5);
        if (this.ship.fuel.current > before) {
          this.log(`tour scout: refuelled at ${here} (${before} → ${this.ship.fuel.current}); re-evaluating next tick`);
          return true;
        }
      }
      this.log(`tour scout: no reachable target from ${here} (${targets.length} known)`);
      return false;
    }
    // Honour the refuel result. This used to be a bare await: refuelIfNeeded()
    // would log "WARN: stranded (0/300 fuel...) and no reachable market",
    // return false, and the navigate went ahead regardless — failing with
    // "requires 1 more fuel for navigation" and repeating the whole sequence
    // every tick, forever. A ship that cannot pay for the leg stands down and
    // waits to be rescued instead of hammering the API.
    if (!(await this.refuelIfNeeded(5, target))) {
      this.log(`tour scout: holding at ${here} — not enough fuel for ${target} and nowhere to refuel`);
      return false;
    }
    this.log(`tour scout: touring ${target}`);
    await this.navigateTo(target);
    await this.ensureDocked();
    if (this.recordMarket) await this.recordMarket(target);
    if (this.recordShipyard) await this.recordShipyard(target);
    return true;
  }

  /** Nearest unreviewed asteroid field, rotating once all are covered. */
  private pickSurveyTarget(): WaypointPos | undefined {
    const fields = this.registry.waypointsIn(this.ship.nav.systemSymbol).filter(
      (wp) => wp.type === "ASTEROID_FIELD" || wp.type === "ASTEROID" || wp.type === "ENGINEERED_ASTEROID",
    );
    if (fields.length > 0 && fields.every((f) => this.surveyedFields.has(f.symbol))) {
      // Full pass complete: start a fresh rotation so fields get re-surveyed as surveys expire.
      this.surveyedFields.clear();
    }
    // If we're already in an asteroid field, prefer staying put — re-surveying the
    // current field keeps the pool fresh and avoids burning fuel flying around.
    const here = this.registry.position(this.ship.nav.waypointSymbol);
    if (here && fields.some((f) => f.symbol === here.symbol)) {
      return here;
    }
    const candidates = fields.filter((f) => !this.surveyedFields.has(f.symbol));
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of candidates) {
      const dist = this.distanceTo(wp);
      if (dist >= bestDist) continue;
      if (this.ship.fuel.capacity > 0) {
        const roundTrip = this.fuelNeededRoundTrip(wp.symbol);
        if (roundTrip > this.ship.fuel.current) {
          const out = this.estimatedFuelTo(wp.symbol);
          if (out > this.ship.fuel.current) continue;
        }
      }
      bestDist = dist;
      best = wp;
    }
    return best;
  }

  private async extractUntilFull(): Promise<void> {
    let safety = 0;
    this.miningSession = this.ship.nav.waypointSymbol;
    // Non-refiners can still mine far more per action by extracting through a
    // shared survey (surveys guarantee a high-yield deposit). Prefer a pooled
    // survey at this waypoint; fall back to plain extraction.
    let survey: components["schemas"]["Survey"] | undefined =
      this.cachedSurvey() ??
      this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d])) ??
      (this.hasSurveyor() ? await this.createAndPickSurvey() : undefined);
    this.rememberSurvey(survey);
    if (survey) this.log(`using survey at ${this.ship.nav.waypointSymbol}`);
    while (this.cargoFree() > 0 && safety < 40) {
      safety += 1;
      try {
        this.currentStep = { kind: "transacting", action: "extract" };
        const res = survey
          ? await this.api.extractWithSurvey(this.symbol, survey)
          : await this.api.extract(this.symbol);
        this.currentStep = IDLE_STEP;
        this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
        const got = res.extraction.yield;
        this.onActivity?.("extract", `+${got.units}u ${got.symbol} (${this.ship.cargo.units}/${this.ship.cargo.capacity})`, undefined, this.symbol);
        this.log(`extracted ${got.units}u ${got.symbol}`);
        await this.waitCooldown();
      } catch (err) {
        if (err instanceof Pending) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cooldown")) {
          this.log(`extract pending cooldown, waiting…`);
          await this.pause(6_000);
          continue;
        }
        if (survey && /exhaust|expire|signature|invalid/i.test(msg)) {
          this.log(`survey no longer usable: ${msg}`);
          this.surveyPool?.invalidate(this.ship.nav.waypointSymbol, survey.signature);
          survey =
            this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d])) ??
            (this.hasSurveyor() ? await this.createAndPickSurvey() : undefined);
          this.rememberSurvey(survey);
          if (survey) continue;
          this.log("no usable survey; falling back to plain extraction");
        }
        this.log(`extract failed: ${msg}`);
        this.miningSession = null;
        return;
      }
    }
    this.miningSession = null;
    if (safety >= 40) this.log("extract loop hit safety cap");
  }

  /**
   * Sell the hold at `expectedAt`.
   *
   * The waypoint is a parameter rather than "wherever the ship is" because
   * rule 5 needs something to check against. This is called after a
   * navigate whose failure the caller does not inspect, so without the
   * assertion a miner whose trip to the market never happened would sell
   * its ore at the asteroid field — to whatever market the API found there,
   * at whatever price, logged as a successful sale at the target.
   */
  private async sellAllCargo(expectedAt: string): Promise<void> {
    this.proxy.assertAt(expectedAt, "sell cargo");
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const inventory = [...this.ship.cargo.inventory];
    for (const item of inventory) {
      if (protectedGoods.has(item.symbol)) {
        this.log(`keeping ${item.symbol} (reserved for mission)`);
        continue;
      }
      try {
        this.currentStep = { kind: "transacting", action: "sell", good: item.symbol };
        const res = await this.api.sellCargo(this.symbol, item.symbol, item.units);
        this.currentStep = IDLE_STEP;
        this.ship = { ...this.ship, cargo: res.cargo };
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: this.symbol,
          waypointSymbol: this.ship.nav.waypointSymbol,
          type: "SELL",
          tradeSymbol: item.symbol,
          units: item.units,
          pricePerUnit: res.transaction.pricePerUnit,
          total: res.transaction.totalPrice,
        });
        this.log(
          `sold ${item.units}u ${item.symbol} @ ${res.transaction.pricePerUnit}c = ${res.transaction.totalPrice}c`,
        );
        this.onActivity?.("sell", `${item.units}u ${item.symbol} @ ${res.transaction.pricePerUnit}c`, res.transaction.totalPrice);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`sell failed: ${msg}`);
      }
    }
  }

  /**
   * True when the fleet is halted and this ship must not act.
   *
   * Every agent loop checks this at the top of each iteration. It is a stopgap:
   * the loops are what make Halt hard to enforce in the first place, and the
   * greenfield scheduler makes it structural by simply not dispatching work
   * (see docs/greenfield-design.md, pillar 3). Until then, this is the honest
   * fix — a halted fleet must actually stop.
   */
  private halted(): boolean {
    return this.shouldRun !== undefined && !this.shouldRun();
  }

  /** Surveyor-only loop: survey fields and deposit into the shared pool. */
  /** Drive the tour scout loop (market/shipyard inventory refresh). */
  /**
   * One keeper poll: reposition to the assigned market if needed, snapshot
   * it, and record shipyard inventory too if this is a shipyard-market.
   * Returns whether there was an assigned market to poll at all — `false`
   * means "nothing to do," same as every other agent's `tick()`-style
   * boolean, extracted here (Greenfield Phase 7) so `keeperLoop()` and
   * `nextKeeperTask()` can share one implementation instead of the loop
   * body being the only place this logic existed.
   */
  private async keeperPoll(): Promise<boolean> {
    // The fleet itself is driving this hull (repair, fuel ferry, operator
    // hold), so acting here is the two-owners race that had a diverter and a
    // tour agent alternately flying the same ship every few seconds for a
    // day. Stand down until the intent changes.
    const standDown = standDownReason(this.intentFor?.());
    if (standDown) {
      this.log(`standing down, fleet is driving this ship: ${standDown}`);
      return false;
    }

    const market = this.keeperMarket?.();
    if (!market) {
      this.log("keeper: no assigned market");
      return false;
    }
    await this.refresh();
    // If we're not at the assigned market, fly there (one-time reposition).
    // Refuel first — navigateTo() bails when fuel is short instead of
    // topping up, which would strand the keeper mid-hop.
    if (this.ship.nav.waypointSymbol !== market || this.ship.nav.status === "IN_TRANSIT") {
      await this.refuelIfNeeded(5, market);
      await this.navigateTo(market);
    }
    await this.ensureDocked();
    if (this.recordMarket) await this.recordMarket(market);
    // Shipyard-markets (A2/C43/H56) also need their ship stock kept fresh —
    // shipyard inventory is only visible when a ship is docked there.
    if (this.recordShipyard) await this.recordShipyard(market);
    this.log(`keeper: snapshot ${market} (${this.ship.fuel.current}/${this.ship.fuel.capacity} fuel)`);
    return true;
  }

  /**
   * Greenfield Phase 7: Scheduler `Task` producers for this class's four
   * roles, same wrapping approach as `TraderAgent.nextTask()` (Phase 6) —
   * each wraps the pre-existing bounded work-unit method its own loop
   * variant already calls (`tick`/`surveyScout`/`tourScout`/`keeperPoll`),
   * reimplementing none of the underlying logic, only its control-flow
   * shape and timing. None of `runLoop`/`surveyLoop`/`tourLoop`/`keeperLoop`
   * are removed or changed in behavior; `fleet.run()` still calls those,
   * not these — see README's Greenfield section.
   *
   * Priority buckets follow the design doc's own scheme (0 rescue · 1
   * mission · 2 trade · 3 survey/keeper · 4 telemetry), extended by one
   * judgment call each for the two roles the doc doesn't name directly:
   * mining is revenue-producing the same way trading is, so `nextTask()`
   * (this class's miner role) shares trade's priority 2; a tour scout's
   * market/shipyard intel refresh is background reference data, not active
   * production, so `nextTourTask()` sits at telemetry's priority 4.
   */
  nextTask(earliestRunAt = Date.now()): Task {
    // Deliberately does NOT set this.running = true here — every external
    // enqueue site already does that immediately before calling this (see
    // fleet.ts's setShipRole()/syncSchedulerTasks()). This method is also
    // called internally, from within its own run()'s `next: this.nextTask(...)`
    // chaining — if it reset running=true unconditionally there too, a
    // stop() landing while a task is mid-flight (tick() can run 10s of
    // seconds) would get silently undone the moment that in-flight call
    // finishes and chains its own next task, resurrecting a supposedly-
    // stopped agent into an immortal loop. Confirmed live: a ship converted
    // from miner to tour kept mining indefinitely, in parallel with its new
    // tour duty, because of exactly this race.
    return {
      id: `${this.symbol}-mine`,
      shipSymbol: this.symbol,
      priority: 2,
      estimatedCalls: 3,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        // Cutover: stop() (scrapped, or converted to keeper — see fleet.ts's
        // removeShip()/maybeAssignKeepers()) must end this chain for good,
        // not just the old runLoop()'s while condition.
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) return { actualCalls: 0, next: this.nextTask(Date.now() + HALT_POLL_MS) };
        const before = this.api.getCallCount();
        this.schedulerDriven = true;
        // See TraderAgent.nextTask()'s comment: inFlight was only ever set by
        // runLoop(), dead in production, so suspend()'s wait-for-in-flight-
        // tick was inert under the scheduler this method actually runs on.
        const p = this.tick();
        this.inFlight = p;
        try {
          const made = await p;
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof Pending) return { actualCalls, next: this.nextTask(err.resumeAt) };
          this.log(`agent error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }

  nextSurveyTask(earliestRunAt = Date.now()): Task {
    // See nextTask()'s comment: not set here, only by external enqueue sites.
    return {
      id: `${this.symbol}-survey`,
      shipSymbol: this.symbol,
      priority: 3,
      estimatedCalls: 2,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) return { actualCalls: 0, next: this.nextSurveyTask(Date.now() + HALT_POLL_MS) };
        const before = this.api.getCallCount();
        this.schedulerDriven = true;
        // See TraderAgent.nextTask()'s comment on inFlight.
        const p = this.surveyScout();
        this.inFlight = p;
        try {
          const made = await p;
          return { actualCalls: this.api.getCallCount() - before, next: this.nextSurveyTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof Pending) return { actualCalls, next: this.nextSurveyTask(err.resumeAt) };
          this.log(`surveyor error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextSurveyTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }

  nextTourTask(earliestRunAt = Date.now()): Task {
    // See nextTask()'s comment: not set here, only by external enqueue sites.
    return {
      id: `${this.symbol}-tour`,
      shipSymbol: this.symbol,
      // 3, alongside surveying and keeping, not 4 with idle telemetry. A tour
      // is what produces the price intel every trade route is scored from, so
      // starving it under budget pressure starves trading one cycle later —
      // and the tour fleet is the only thing that finds new markets at all,
      // which is the whole point of exploring. Scouts stay at 4: charting an
      // empty waypoint is genuinely lower value than refreshing a price.
      priority: 3,
      estimatedCalls: 2,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) return { actualCalls: 0, next: this.nextTourTask(Date.now() + HALT_POLL_MS) };
        const before = this.api.getCallCount();
        this.schedulerDriven = true;
        // See TraderAgent.nextTask()'s comment on inFlight.
        const p = this.tourScout();
        this.inFlight = p;
        try {
          const made = await p;
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTourTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof Pending) return { actualCalls, next: this.nextTourTask(err.resumeAt) };
          this.log(`tour error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTourTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }

  /** Unlike the other three, a successful keeper poll backs off 5 minutes (KEEPER_POLL_MS-equivalent), not 0 — same as keeperLoop()'s own sleep(5 * 60_000) after a snapshot. */
  nextKeeperTask(earliestRunAt = Date.now()): Task {
    // See nextTask()'s comment: not set here, only by external enqueue sites.
    return {
      id: `${this.symbol}-keeper`,
      shipSymbol: this.symbol,
      priority: 3,
      estimatedCalls: 2,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) return { actualCalls: 0, next: this.nextKeeperTask(Date.now() + HALT_POLL_MS) };
        const before = this.api.getCallCount();
        this.schedulerDriven = true;
        // See TraderAgent.nextTask()'s comment on inFlight.
        const p = this.keeperPoll();
        this.inFlight = p;
        try {
          const snapshotted = await p;
          return { actualCalls: this.api.getCallCount() - before, next: this.nextKeeperTask(Date.now() + (snapshotted ? 5 * 60_000 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof Pending) return { actualCalls, next: this.nextKeeperTask(err.resumeAt) };
          this.log(`keeper error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextKeeperTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }

  /** True while the fleet holds the ship for coordinated work (rescue/mission). */
  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Fly this ship to a waypoint, now.
   *
   * A movement primitive, not an ownership change — step 4. It used to also
   * set `manualGoal`, which took the hull off the board as a side effect of
   * moving it. Nine of its ten callers are internal errands (reach a jump
   * gate, get to a shipyard to buy, station a keeper) that want the ship to
   * *move* and never wanted it benched; that side effect is why
   * `exploreSystem()` needs a release in a `finally` to undo a hold nobody
   * asked for, and why a scout that explored once was never picked again.
   *
   * Staying somewhere is now a separate instruction: the operator's hold,
   * carried on the intent board, where exactly one thing decides who owns a
   * hull.
   */
  async dispatchTo(waypointSymbol: string): Promise<void> {
    this.log(`dispatch → ${waypointSymbol}`);
    await this.refresh();
    if (this.ship.nav.waypointSymbol !== waypointSymbol || this.ship.nav.status === "IN_TRANSIT") {
      await this.refuelIfNeeded(5, waypointSymbol);
      await this.navigateTo(waypointSymbol);
      await this.ensureDocked();
    }
  }

  /**
   * Pin this ship's mining to one asteroid field.
   *
   * Deliberately NOT a manual goal: `dispatchTo` parks a ship at a waypoint and
   * stops it working, which is the wrong tool for "go mine over there". The
   * ship keeps its full autonomous cycle — mine, fill, fly out, sell, come
   * back — it just stops choosing the field for itself. That's the operator
   * overriding one decision rather than taking the ship off the board.
   */
  mineAt(waypointSymbol: string): void {
    this.pinnedMiningTarget = waypointSymbol;
    this.log(`mining pinned to ${waypointSymbol}`);
  }

  /** The asteroid this ship is pinned to, if any. */
  pinnedField(): string | undefined {
    return this.pinnedMiningTarget;
  }

  /** Hand the choice of field back to the ship. */
  unpinMining(): void {
    if (!this.pinnedMiningTarget) return;
    this.pinnedMiningTarget = undefined;
    this.log("mining unpinned; choosing its own field again");
  }

  /**
   * Prevent the agent from acting while the fleet coordinates it manually
   * (e.g. rescues). Awaits any loop iteration already in flight before
   * returning — without this, a caller that immediately starts mutating this
   * ship's nav state directly via the raw API (rescue tender dispatch,
   * mission carrier handoff) can race a `tick()` that's already mid-flight
   * against stale cached ship state, producing "not currently docked" errors.
   */
  async suspend(): Promise<void> {
    this.suspended = true;
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.log("suspended");
  }

  /** Resume autonomous control after a fleet-coordinated operation. */
  resume(): void {
    this.suspended = false;
    this.log("resumed");
  }

  /** Clear any stranded flag (miners can't strand for fuel, so this is a no-op). */
  clearStranded(): void {}

  /** Release the ship back to autonomous operation. */
  release(): void {
    this.unpinMining();
  }

  stop(): void {
    this.running = false;
  }
}

export { ORE_GOODS };
