import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";
import type { SurveyPool } from "./survey.js";
import type { Task, TaskResult } from "./scheduler.js";
import { type AgentStep, IDLE_STEP, NavigationPending } from "./agentStep.js";
import { chooseFlightMode, flightModeReason } from "./flightMode.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

export interface AgentOptions {
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
  private readonly systemSymbol: string;
  private readonly recordLedger: AgentOptions["recordLedger"];
  private readonly deliverCargo: AgentOptions["deliverCargo"];
  private readonly onActivity: AgentOptions["onActivity"];
  private readonly recordMarket: AgentOptions["recordMarket"];
  private readonly waypointPositions = new Map<string, WaypointPos>();
  private markets: MarketSnapshot[] = [];
  private readonly surveyPool: SurveyPool | undefined;
  private readonly protectedGoods?: () => Set<string>;
  private readonly marketTourTargets?: AgentOptions["marketTourTargets"];
  private readonly staleMarketTargets?: AgentOptions["staleMarketTargets"];
  private readonly shipyardTourTargets?: AgentOptions["shipyardTourTargets"];
  private readonly recordShipyard?: (waypointSymbol: string) => Promise<void>;
  private readonly keeperMarket?: () => string | undefined;
  private readonly shouldRun?: () => boolean;
  private ship: Ship;
  private goal: ShipGoal = { kind: "idle" };
  private manualGoal: ShipGoal | null = null;
  private suspended = false;
  /** The currently in-flight loop iteration (tick/surveyScout/tourScout/keeperPoll), if any.
   *  suspend() awaits this so a caller that's about to mutate this ship's nav state directly
   *  via the raw API (rescue tender dispatch, mission carrier handoff) can't race an iteration
   *  that's already mid-flight against stale cached ship state. */
  private inFlight: Promise<unknown> | null = null;
  private surveyedFields = new Set<string>();
  /** Operator-chosen asteroid field; overrides the ship's own nearest-field pick. */
  private pinnedMiningTarget?: string;
  private marketTourIndex = 0;
  running = false;
  private currentStep: AgentStep = IDLE_STEP;
  /** True only for the exact duration of a nextTask()-family run() closure's
   *  call into tick()/surveyScout()/tourScout()/keeperPoll() — see
   *  agentStep.ts's NavigationPending doc comment for why this is scoped
   *  this narrowly rather than a flag set once and left true: dispatchTo()
   *  also reaches navigateTo(), directly from fleet.ts, never through any of
   *  those four methods, and must keep blocking exactly as before. */
  private schedulerDriven = false;

  /** What this ship is doing right now, if it's mid-navigation or mid-transaction — see agentStep.ts. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: AgentOptions) {
    this.symbol = ship.symbol;
    this.ship = ship;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.deliverCargo = opts.deliverCargo;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.surveyPool = opts.surveyPool;
    this.protectedGoods = opts.protectedGoods;
    this.marketTourTargets = opts.marketTourTargets;
    this.staleMarketTargets = opts.staleMarketTargets;
    this.shipyardTourTargets = opts.shipyardTourTargets;
    this.recordShipyard = opts.recordShipyard;
    this.keeperMarket = opts.keeperMarket;
    this.shouldRun = opts.shouldRun;
    this.systemSymbol = ship.nav.systemSymbol;
  }

  /** Seed the agent with known waypoint positions and market snapshots for its system. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[]): this {
    for (const p of positions) this.waypointPositions.set(p.symbol, p);
    this.markets = markets;
    return this;
  }

  getShip(): Ship {
    return this.ship;
  }

  private async refresh(): Promise<void> {
    this.ship = await this.api.getShip(this.symbol);
  }

  private async waitCooldown(): Promise<void> {
    const cd = this.ship.cooldown;
    if (!cd || cd.remainingSeconds <= 0) return;
    this.log(`cooldown ${cd.remainingSeconds}s`);
    await sleep(cd.remainingSeconds * 1000 + 250);
    await this.refresh();
  }

  private async ensureInOrbit(): Promise<void> {
    if (this.ship.nav.status === "IN_ORBIT") return;
    if (this.ship.nav.status === "IN_TRANSIT") {
      await this.waitForArrival();
    }
    if (this.ship.nav.status === "DOCKED") {
      this.log("docking → orbit");
      await this.api.orbitShip(this.symbol);
      await this.refresh();
    }
  }

  private async ensureDocked(): Promise<void> {
    if (this.ship.nav.status === "DOCKED") return;
    if (this.ship.nav.status === "IN_TRANSIT") {
      await this.waitForArrival();
    }
    if (this.ship.nav.status === "IN_ORBIT") {
      this.log("orbit → dock");
      await this.api.dockShip(this.symbol);
      await this.refresh();
      if (this.recordMarket) await this.recordMarket(this.ship.nav.waypointSymbol);
    }
  }

  /** Wait until the ship has finished its current transit. */
  private async waitForArrival(): Promise<void> {
    if (this.schedulerDriven) {
      // Always refresh before deciding: whatever route this.ship currently
      // carries isn't guaranteed to be from *this* transit (ensureInOrbit()/
      // ensureDocked() call this using whatever this.ship already holds, not
      // a value this method itself just fetched) — a single non-blocking
      // check has no retry loop to self-correct that the way the blocking
      // version below does, so it must get real, current data first.
      await this.refresh();
      if (this.ship.nav.status !== "IN_TRANSIT") return;
      const wait = new Date(this.ship.nav.route.arrival).getTime() - Date.now();
      throw new NavigationPending(Date.now() + wait);
    }
    for (;;) {
      const arrival = new Date(this.ship.nav.route.arrival).getTime();
      const wait = arrival - Date.now();
      if (wait > 0) {
        this.log(`in transit, arrival in ${Math.round(wait / 1000)}s`);
        await sleep(wait + 1000);
      }
      await this.refresh();
      if (this.ship.nav.status !== "IN_TRANSIT") return;
    }
  }

  private async navigateTo(waypoint: string): Promise<void> {
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") {
      return;
    }
    await this.ensureInOrbit();
    const need = this.estimatedFuelTo(waypoint);
    // Flight mode: see flightMode.ts's own comment for the exact policy.
    // DRIFT is tried here (instead of giving up, as this used to do
    // unconditionally on an unaffordable-at-CRUISE leg) because the real
    // navigate call below is the final authority on whether the leg is
    // actually reachable, DRIFT or not — this never makes stranding worse,
    // only sometimes avoids it. A patch failure doesn't block the attempt:
    // worst case, navigateShip() below is tried in whatever mode was
    // already set, same as before this existed.
    if (this.ship.fuel.capacity > 0) {
      const mode = chooseFlightMode(need, this.ship.fuel.current, this.ship.fuel.capacity);
      if (mode !== this.ship.nav.flightMode) {
        try {
          const patched = await this.api.patchShipNav(this.symbol, mode);
          this.ship = { ...this.ship, nav: patched.nav, fuel: patched.fuel };
          this.onActivity?.("flightmode", `${mode.toLowerCase()} mode${flightModeReason(mode)} (${this.ship.fuel.current}/${this.ship.fuel.capacity} fuel)`, undefined, this.symbol);
        } catch (err) {
          this.log(`flight mode change to ${mode} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    this.currentStep = { kind: "navigating", to: waypoint };
    try {
      const arrival = await this.api.navigateShip(this.symbol, waypoint);
      this.ship = { ...this.ship, nav: arrival.nav, fuel: arrival.fuel };
      this.onActivity?.("navigate", `→ ${waypoint} (${arrival.fuel.current}/${arrival.fuel.capacity} fuel)`, undefined, this.symbol);
      if (this.schedulerDriven) {
        const wait = new Date(arrival.nav.route.arrival).getTime() - Date.now();
        if (wait > 0) throw new NavigationPending(Date.now() + wait);
        await this.refresh();
      } else {
        const wait = new Date(arrival.nav.route.arrival).getTime() - Date.now();
        if (wait > 0) {
          this.log(`navigating to ${waypoint}, ETA ${Math.round(wait / 1000)}s`);
          await sleep(wait + 1000);
        }
        await this.refresh();
      }
      this.currentStep = IDLE_STEP;
    } catch (err) {
      if (err instanceof NavigationPending) {
        // Leave currentStep as "navigating" — the ship genuinely still is;
        // see trader.ts's identical navigateTo() catch for why.
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/already located at the destination|already at the destination/i.test(msg)) {
        // Stale cached nav state — the ship is already there. Refresh and continue.
        await this.refresh();
        this.currentStep = IDLE_STEP;
        return;
      }
      this.currentStep = IDLE_STEP;
      throw err;
    }
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
    for (const m of this.markets) {
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
   *  Previously used the price from whichever market in `this.markets`
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
      const pinned = this.waypointPositions.get(this.pinnedMiningTarget);
      if (pinned) return pinned;
      this.log(`pinned field ${this.pinnedMiningTarget} is not in the atlas; picking the nearest instead`);
    }
    // If we're parked at a market, we can refuel before leaving — budget a full tank.
    const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
    const fuelBudget =
      this.ship.fuel.capacity > 0 ? (atMarket ? this.ship.fuel.capacity : this.ship.fuel.current) : 0;
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of this.waypointPositions.values()) {
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
    for (const m of this.markets) {
      if (m.symbol === this.ship.nav.waypointSymbol) continue;
      const d = this.estimatedFuelTo(m.symbol);
      if (d > this.ship.fuel.current) continue; // can't reach it now
      const mineableFromThere = [...this.waypointPositions.values()].some(
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
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (!here) return 0;
    return Math.hypot(wp.x - here.x, wp.y - here.y);
  }

  /** Choose a selling destination. Prefer a market that imports the good (profile visible remotely).
   *  Only markets the ship could actually reach with a full tank are considered, so a ship stranded
   *  far from a niche-importer (e.g. ore importers at B7, 303 fuel away from an 80-tank ship) does
   *  not chase an unreachable sell target forever. */
  private pickSellTarget(): string | undefined {
    const good = this.ship.cargo.inventory[0];
    if (!good) return undefined;
    const candidates = this.markets.filter((m) => {
      if (m.imports.includes(good.symbol) || m.exchange.includes(good.symbol)) return true;
      const g = m.tradeGoods[good.symbol];
      return g && (g.type === "IMPORT" || g.type === "EXCHANGE");
    });
    const fuelCap = this.ship.fuel.capacity;
    const reachable = candidates.filter(
      (m) => fuelCap <= 0 || this.estimatedFuelTo(m.symbol) <= fuelCap,
    );
    // Never chase a market the ship cannot reach even on a full tank (e.g. ore importer
    // B7 at 303 fuel vs an 80-tank ship) — that just loops on "cannot navigate".
    const pool = reachable.length > 0 ? reachable : [];
    if (pool.length === 0) return undefined;
    // Rank by sellPrice — what this market pays the ship for the good — not
    // purchasePrice, which is what buying FROM that market would cost and has
    // no bearing on a sell decision. Sorting by purchasePrice here picked
    // whichever reachable market was most expensive to buy from, which can
    // easily be a market that pays poorly to sell to; that produced real
    // near-zero-proceeds sales (a market with a high purchasePrice but a low
    // sellPrice looked "best" and won the sort, when it was actually one of
    // the worst places to sell).
    pool.sort((a, b) => {
      const pa = a.tradeGoods[good.symbol]?.sellPrice ?? 0;
      const pb = b.tradeGoods[good.symbol]?.sellPrice ?? 0;
      return pb - pa;
    });
    return pool[0]?.symbol;
  }

  /** Dock at a market waypoint and refresh its price snapshot. */
  private async observeMarket(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    const market = await this.api.getMarket(this.systemSymbol, waypoint);
    const snapshot = this.markets.find((m) => m.symbol === waypoint) ?? {
      symbol: waypoint,
      systemSymbol: this.systemSymbol,
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
    if (!this.markets.some((m) => m.symbol === waypoint)) this.markets.push(snapshot);
  }

  /** Tour unvisited markets to build the price table. Returns true if a tour happened. */
  private async discoverMarkets(): Promise<boolean> {
    const candidates = this.markets
      .filter((m) => Object.keys(m.tradeGoods).length === 0)
      .filter((m) => this.ship.fuel.capacity <= 0 || this.fuelNeededRoundTrip(m.symbol) <= this.ship.fuel.capacity)
      .sort(
        (a, b) =>
          this.distanceTo(this.waypointPositions.get(a.symbol)!) -
          this.distanceTo(this.waypointPositions.get(b.symbol)!),
      );
    const target = candidates[0];
    if (!target) return false;
    this.log(`discovering market at ${target.symbol}`);
    await this.refuelIfNeeded(5, target.symbol);
    await this.observeMarket(target.symbol);
    return true;
  }

  private estimatedFuelTo(waypoint: string): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    const there = this.waypointPositions.get(waypoint);
    if (!here || !there) return 0;
    return Math.max(1, Math.round(Math.hypot(there.x - here.x, there.y - here.y)));
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
    for (const m of this.markets) {
      const d = this.estimatedFuelToBetween(waypoint, m.symbol);
      if (d < bestDist) {
        bestDist = d;
        best = m.symbol;
      }
    }
    return best;
  }

  private estimatedFuelToBetween(a: string, b: string): number {
    const pa = this.waypointPositions.get(a);
    const pb = this.waypointPositions.get(b);
    if (!pa || !pb) return 0;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
  }

  /** Find the nearest market the ship can reach with current fuel. */
  private nearestReachableMarket(): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.markets) {
      const need = this.estimatedFuelTo(m.symbol);
      if (need > this.ship.fuel.current) continue;
      if (need < bestDist) {
        bestDist = need;
        best = m.symbol;
      }
    }
    return best;
  }

  private async refuelIfNeeded(reserve: number, target?: string): Promise<boolean> {
    if (this.ship.fuel.capacity <= 0) return true;
    const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
    const trip = target ? this.fuelNeededRoundTrip(target) : this.ship.fuel.capacity * 0.9;
    if (this.ship.fuel.current > trip + reserve) return true;
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
      return true;
    }
    // Not at a market and fuel is low: try to reach the nearest reachable market first.
    const refuelStop = this.nearestReachableMarket();
    if (refuelStop && refuelStop !== this.ship.nav.waypointSymbol) {
      this.log(`fuel low, detouring to refuel at ${refuelStop}`);
      await this.navigateTo(refuelStop);
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
      return true;
    }
    this.log(`WARN: stranded (${this.ship.fuel.current}/${this.ship.fuel.capacity} fuel, need ${trip}) and no reachable market`);
    return false;
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
    const buyMarket = this.markets.find((m) => m.symbol === here);
    if (!buyMarket || Object.keys(buyMarket.tradeGoods).length === 0) return undefined;
    let best: ReturnType<typeof this.findArbitrageRouteFrom> | undefined;
    for (const [good, buy] of Object.entries(buyMarket.tradeGoods)) {
      for (const sellMarket of this.markets) {
        if (sellMarket.symbol === here) continue;
        const sell = sellMarket.tradeGoods[good];
        if (!sell) continue;
        const margin = sell.sellPrice - buy.purchasePrice;
        if (margin <= 2) continue;
        const fuelToSell = this.estimatedFuelToBetween(here, sellMarket.symbol);
        // Assume we can refuel at the origin market before leaving.
        if (this.ship.fuel.capacity > 0 && fuelToSell > this.ship.fuel.capacity - 5) continue;
        const units = Math.min(buy.tradeVolume, sell.tradeVolume, this.ship.cargo.capacity);
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
    const m = this.markets.find((mm) => mm.symbol === waypoint);
    return m?.tradeGoods["FUEL"]?.purchasePrice;
  }

  /** Buy a good at the current market and fly to sell elsewhere. */
  private async executeArbitrage(route: NonNullable<ReturnType<typeof this.findArbitrageRouteFrom>>): Promise<boolean> {
    await this.ensureDocked();
    await this.refuelIfNeeded(5, route.sellAt);
    const units = Math.min(route.units, this.cargoFree());
    if (units <= 0) return false;
    this.log(`arbitrage: buying ${units}u ${route.good} @ ${route.buyPrice}c`);
    this.currentStep = { kind: "transacting", action: "buy", good: route.good };
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
    if (this.suspended) {
      this.log("suspended: holding position");
      return false;
    }
    await this.refresh();
    await this.waitCooldown();

    // Manual override: if dispatched, stay at the target waypoint and idle.
    if (this.manualGoal) {
      if (this.manualGoal.kind === "idle" && this.manualGoal.waypoint) {
        const target = this.manualGoal.waypoint;
        if (this.ship.nav.waypointSymbol !== target || this.ship.nav.status === "IN_TRANSIT") {
          this.log(`manual: holding course to ${target}`);
          await this.refuelIfNeeded(5, target);
          await this.navigateTo(target);
          await this.ensureDocked();
          return true;
        }
      }
      this.log("manual: holding position");
      return false;
    }

    // If the ship is stranded (no fuel and not at a market), it can't act.
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current <= 0 && !this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol)) {
      this.log(`stranded at ${this.ship.nav.waypointSymbol} (0 fuel, no market); idling`);
      return false;
    }

    // Top up fuel whenever docked at a market and below a safe threshold.
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current < this.ship.fuel.capacity * 0.5) {
      const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
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

    // 1. If cargo is held for a contract delivery, route it first.
    if (this.ship.cargo.units > 0 && this.deliverCargo) {
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
    if (this.ship.cargo.units > 0) {
      const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
      const sellable = this.ship.cargo.inventory.filter((i) => !protectedGoods.has(i.symbol));
      if (sellable.length > 0) {
        const target = this.pickSellTarget();
        if (target) {
          await this.refuelIfNeeded(5, target);
          this.log(`selling ${sellable.length} saleable cargo worth ~${cargoValue}c`);
          await this.navigateTo(target);
          await this.ensureDocked();
          await this.sellAllCargo();
          await this.refresh();
          return true;
        }
        // Cargo full but no known buyer: tour markets to discover prices.
        if (this.ship.cargo.units >= this.ship.cargo.capacity * 0.8) {
          const toured = await this.discoverMarkets();
          if (toured) return true;
        }
      }
    }

    // 3. After selling, if empty at a market, run a quick arbitrage route.
    if (this.ship.cargo.units === 0) {
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
    let survey: components["schemas"]["Survey"] | undefined;
    if (this.hasSurveyor()) {
      survey = await this.createAndPickSurvey();
    } else if (this.surveyPool) {
      survey = this.surveyPool.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
      if (survey) this.log(`using shared survey at ${this.ship.nav.waypointSymbol}`);
    }
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
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cooldown")) {
            this.log(`refine pending cooldown, waiting…`);
            await sleep(6_000);
            await this.refresh();
            continue;
          }
          this.log(`refine failed: ${msg}`);
          return;
        }
        continue;
      }
      // Nothing left to refine: mine until the hold is full.
      if (this.cargoFree() === 0) return;
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
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cooldown")) {
          this.log(`extract pending cooldown, waiting…`);
          await sleep(6_000);
          await this.refresh();
          continue;
        }
        if (survey && /exhaust|expire|signature|invalid/i.test(msg)) {
          this.log(`survey no longer usable: ${msg}; re-surveying`);
          this.surveyPool?.invalidate(this.ship.nav.waypointSymbol, survey.signature);
          survey = this.hasSurveyor()
            ? await this.createAndPickSurvey()
            : this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
          if (survey) continue;
          this.log("no usable survey; falling back to plain extraction");
        }
        this.log(`extract failed: ${msg}`);
        return;
      }
    }
    if (safety >= 60) this.log("mineAndRefine hit safety cap");
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
      await this.waitCooldown();
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
      return best;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cooldown")) {
        this.log(`survey pending cooldown, waiting…`);
        await sleep(6_000);
        await this.refresh();
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
    if (this.suspended) {
      this.log("tour scout: suspended, holding");
      return false;
    }
    await this.refresh();
    // If manually dispatched, hold at the target until released — a fleet
    // operator moving a ship to a shipyard must not have the tour loop yank it
    // off to the next market.
    if (this.manualGoal && this.manualGoal.kind === "idle" && this.manualGoal.waypoint) {
      if (this.ship.nav.waypointSymbol !== this.manualGoal.waypoint || this.ship.nav.status === "IN_TRANSIT") {
        await this.navigateTo(this.manualGoal.waypoint);
        await this.ensureDocked();
      }
      return true;
    }
    this.log(`tour scout: tick @ ${this.ship.nav.waypointSymbol} (fuel ${this.ship.fuel.current}/${this.ship.fuel.capacity})`);

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
    const herePos = this.waypointPositions.get(here);
    const reachable = targets
      .filter((t) => t !== here)
      .map((t) => {
        const pos = this.waypointPositions.get(t);
        const dist = herePos && pos ? Math.max(1, Math.round(Math.hypot(pos.x - herePos.x, pos.y - herePos.y))) : Infinity;
        return { t, dist, stale: stale.has(t) };
      })
      .filter((x) => x.dist <= this.ship.fuel.capacity)
      .sort((a, b) => Number(b.stale) - Number(a.stale) || a.dist - b.dist);
    const target = reachable[0]?.t;
    if (!target) {
      this.log(`tour scout: no reachable target from ${here} (${targets.length} known)`);
      return false;
    }
    await this.refuelIfNeeded(5, target);
    this.log(`tour scout: touring ${target}`);
    await this.navigateTo(target);
    await this.ensureDocked();
    if (this.recordMarket) await this.recordMarket(target);
    if (this.recordShipyard) await this.recordShipyard(target);
    return true;
  }

  /** Nearest unreviewed asteroid field, rotating once all are covered. */
  private pickSurveyTarget(): WaypointPos | undefined {
    const fields = [...this.waypointPositions.values()].filter(
      (wp) => wp.type === "ASTEROID_FIELD" || wp.type === "ASTEROID" || wp.type === "ENGINEERED_ASTEROID",
    );
    if (fields.length > 0 && fields.every((f) => this.surveyedFields.has(f.symbol))) {
      // Full pass complete: start a fresh rotation so fields get re-surveyed as surveys expire.
      this.surveyedFields.clear();
    }
    // If we're already in an asteroid field, prefer staying put — re-surveying the
    // current field keeps the pool fresh and avoids burning fuel flying around.
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
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
    // Non-refiners can still mine far more per action by extracting through a
    // shared survey (surveys guarantee a high-yield deposit). Prefer a pooled
    // survey at this waypoint; fall back to plain extraction.
    let survey: components["schemas"]["Survey"] | undefined =
      this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d])) ??
      (this.hasSurveyor() ? await this.createAndPickSurvey() : undefined);
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
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cooldown")) {
          this.log(`extract pending cooldown, waiting…`);
          await sleep(6_000);
          await this.refresh();
          continue;
        }
        if (survey && /exhaust|expire|signature|invalid/i.test(msg)) {
          this.log(`survey no longer usable: ${msg}`);
          this.surveyPool?.invalidate(this.ship.nav.waypointSymbol, survey.signature);
          survey =
            this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d])) ??
            (this.hasSurveyor() ? await this.createAndPickSurvey() : undefined);
          if (survey) continue;
          this.log("no usable survey; falling back to plain extraction");
        }
        this.log(`extract failed: ${msg}`);
        return;
      }
    }
    if (safety >= 40) this.log("extract loop hit safety cap");
  }

  private async sellAllCargo(): Promise<void> {
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

  async runLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const p = this.tick();
        this.inFlight = p;
        const made = await p;
        if (!made) {
          await sleep(30_000);
        }
      } catch (err) {
        this.log(`agent error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      } finally {
        this.inFlight = null;
      }
    }
    this.running = false;
  }

  /** Surveyor-only loop: survey fields and deposit into the shared pool. */
  async surveyLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const p = this.surveyScout();
        this.inFlight = p;
        const made = await p;
        if (!made) {
          await sleep(30_000);
        }
      } catch (err) {
        this.log(`surveyor error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      } finally {
        this.inFlight = null;
      }
    }
    this.running = false;
  }

  /** Drive the tour scout loop (market/shipyard inventory refresh). */
  async tourLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const p = this.tourScout();
        this.inFlight = p;
        const made = await p;
        if (!made) await sleep(30_000);
      } catch (err) {
        this.log(`tour error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      } finally {
        this.inFlight = null;
      }
    }
    this.running = false;
  }

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
   * Stationary keeper: poll one market on a timer so its prices never go stale.
   * The ship stays docked at its assigned market and re-snapshots it every
   * KEEPER_POLL_MS. Used for probes (0 fuel, can only sit at their spawn
   * shipyard) and repurposed miners parked at outer buy markets.
   */
  async keeperLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const p = this.keeperPoll();
        this.inFlight = p;
        const snapshotted = await p;
        await sleep(snapshotted ? 5 * 60_000 : 30_000);
      } catch (err) {
        this.log(`keeper error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      } finally {
        this.inFlight = null;
      }
    }
    this.running = false;
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
        try {
          const made = await this.tick();
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof NavigationPending) return { actualCalls, next: this.nextTask(err.resumeAt) };
          this.log(`agent error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
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
        try {
          const made = await this.surveyScout();
          return { actualCalls: this.api.getCallCount() - before, next: this.nextSurveyTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof NavigationPending) return { actualCalls, next: this.nextSurveyTask(err.resumeAt) };
          this.log(`surveyor error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextSurveyTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
        }
      },
    };
  }

  nextTourTask(earliestRunAt = Date.now()): Task {
    // See nextTask()'s comment: not set here, only by external enqueue sites.
    return {
      id: `${this.symbol}-tour`,
      shipSymbol: this.symbol,
      priority: 4,
      estimatedCalls: 2,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) return { actualCalls: 0, next: this.nextTourTask(Date.now() + HALT_POLL_MS) };
        const before = this.api.getCallCount();
        this.schedulerDriven = true;
        try {
          const made = await this.tourScout();
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTourTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof NavigationPending) return { actualCalls, next: this.nextTourTask(err.resumeAt) };
          this.log(`tour error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTourTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
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
        try {
          const snapshotted = await this.keeperPoll();
          return { actualCalls: this.api.getCallCount() - before, next: this.nextKeeperTask(Date.now() + (snapshotted ? 5 * 60_000 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof NavigationPending) return { actualCalls, next: this.nextKeeperTask(err.resumeAt) };
          this.log(`keeper error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextKeeperTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
        }
      },
    };
  }

  /** True when the ship is under a manual command instead of autonomous loop. */
  isManual(): boolean {
    return this.manualGoal !== null;
  }

  /** True while the fleet holds the ship for coordinated work (rescue/mission). */
  isSuspended(): boolean {
    return this.suspended;
  }

  /** Manually dispatch this ship to a waypoint; once there it will idle until released. */
  async dispatchTo(waypointSymbol: string): Promise<void> {
    this.manualGoal = { kind: "idle", waypoint: waypointSymbol };
    this.log(`manual dispatch → ${waypointSymbol}`);
    await this.refresh();
    if (this.ship.nav.waypointSymbol !== waypointSymbol || this.ship.nav.status === "IN_TRANSIT") {
      await this.refuelIfNeeded(5, waypointSymbol);
      await this.navigateTo(waypointSymbol);
      await this.ensureDocked();
    }
    this.manualGoal = { kind: "idle", waypoint: waypointSymbol };
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
    if (this.manualGoal) {
      this.manualGoal = null;
      this.log("released to autonomous control");
    }
  }

  stop(): void {
    this.running = false;
  }
}

export { ORE_GOODS };
