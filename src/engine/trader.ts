import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";
import type { GalaxyAtlas } from "./galaxy.js";
import { CROSS_SYSTEM_JUMP_COST_ESTIMATE, type TraderAssignment } from "./dispatcher.js";
import type { Task, TaskResult } from "./scheduler.js";
import { type AgentStep, IDLE_STEP, Pending } from "./agentStep.js";
import { Registry } from "./registry.js";
import { standDownReason } from "./intent.js";
import { ShipProxy } from "./shipProxy.js";

export type Ship = components["schemas"]["Ship"];

/** The subset of a route needed to fly it directly — the shape shared by a
 *  full DispatchRoute (the claim path) and a "direct"-role TraderAssignment. */
interface DirectLeg {
  good: string;
  buyAt: string;
  sellAt: string;
  buyPrice: number;
  sellPrice: number;
}

/** A direct leg the ship has priced against its own table and can fly now. */
interface Route extends DirectLeg {
  margin: number;
  volume: number;
}

export interface TraderOptions {
  /** Repair this ship where it stands; forwarded to the shared executor. */
  repairHere?: (shipSymbol: string) => Promise<void>;
  api: SpaceTradersAPI;
  log?: (msg: string) => void;
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "PURCHASE" | "SELL" | "REFUEL";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** Called for notable events for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Provide latest market snapshots from persistent store on each tick. */
  getMarketSnapshots?: () => Promise<{ waypointSymbol: string; goodSymbol: string; purchasePrice: number; sellPrice: number; tradeVolume: number }[]>;
  /** Multi-system atlas for jump routing between systems. */
  atlas?: GalaxyAtlas;
  /** Trade symbols reserved for missions; the trader must never buy/sell these. */
  protectedGoods?: () => Set<string>;
  /** Trade symbols being carried / traded by another ship; avoid these to prevent buying competition. */
  reservedGoods?: () => Set<string>;
  /** Centralized dispatch: the specific assignment this trader holds (or undefined if it holds no claim). */
  assignedRoute?: () => TraderAssignment | undefined;
  /**
   * Take the best dispatch route no other trader holds. `accept` rejects routes
   * this ship can't actually fly, so the dispatcher moves on to the next-best
   * one within the same call. Must be synchronous: that's what makes the claim
   * atomic against the other traders' loops. Only ever hands back a "direct"
   * assignment — the dispatcher's live-claim path predates warehousing roles.
   */
  claimRoute?: (accept: (route: DirectLeg) => boolean) => TraderAssignment | undefined;
  /** Give up this trader's claim so a fleetmate can take the good. */
  releaseRoute?: () => void;
  /** Current credit balance, used to cap purchase volume by affordability. */
  getCredits?: () => number;
  /** Apply the cash floor to a balance — `fleet.spendableCredits(live)`.
   *  Separate from getCredits() because the two answer different questions:
   *  getCredits() is the fleet's cached balance, fine for ranking routes,
   *  while a purchase must be sized against the *live* balance (the cache is
   *  refreshed once per tick and goes stale the moment another ship buys)
   *  with the floor then subtracted from it. */
  applyCashFloor?: (credits: number) => number;
  /** Max acceptable loss per unit (percent of cost basis) before refusing to sell. Default 15. */
  maxLossPct?: number;
  /** Minimum per-unit margin for a route to be worth taking. Default 10. */
  marginFloor?: number;
  /**
   * How long a price stays usable, in minutes. The dispatcher filters its route
   * list by the same number, so both are reasoning about the same markets.
   * Default 90.
   */
  intelMaxAgeMin?: () => number;
  /** Called at the specific moments marginFloor/maxLossPct/snapshotMaxAgeMin
   *  actually change this ship's decision — see doctrine.ts's `recordFire()`. */
  recordDoctrineFire?: (key: string) => void;
  /** Where the warehouse ship is parked, if one is designated — the rendezvous point for buy/sell-role legs. */
  getWarehouseShip?: () => { shipSymbol: string; waypointSymbol: string } | undefined;
  /** Units of a good currently held in the warehouse, for sizing a sell-role withdrawal. */
  warehouseBalance?: (good: string) => Promise<number>;
  /** Record a deposit into the warehouse's bookkeeping — call only after the real transferCargo into the warehouse ship has succeeded. */
  warehouseDeposit?: (good: string, units: number, price: number, shipSymbol: string) => Promise<void>;
  /** Record a withdrawal from the warehouse's bookkeeping — call only after the real transferCargo out of the warehouse ship has succeeded. Returns the actual units removed and their cost basis. */
  warehouseWithdraw?: (good: string, units: number, shipSymbol: string) => Promise<{ units: number; avgCost: number }>;
  /** Minimum per-unit margin over cost basis required to sell out of the warehouse. Default 0 (any profit clears). */
  warehouseMinMargin?: () => number;
  /** Whether the ship may act right now. False while the fleet is halted. */
  /**
   * This ship's committed intent, read live from the fleet's board. An agent
   * stands down rather than acting when the fleet itself is driving the hull
   * — see intent.ts's drivenByFleet(). Optional, so an agent built without a
   * board (a test, a bare CLI run) behaves exactly as before.
   */
  intentFor?: () => import("./intent.js").ShipIntent | undefined;
  shouldRun?: () => boolean;
  /** Recover a cost basis this process never saw, from the trade ledger. */
  recoverCostBasis?: (good: string) => Promise<number | undefined>;
  /**
   * Route/deliver contract cargo this ship is carrying — same contract
   * (fleet.ts's ContractManager.deliverVia) ShipAgent already wires in.
   * Checked at the top of tick(), before clearLeftoverCargo() or any route
   * work, so a trader that ends up holding a contract-deliverable good
   * (via a "contractBuy" assignment, a warehouse withdrawal, a transfer,
   * whatever) delivers it instead of selling/jettisoning it — the whole
   * reason clearLeftoverCargo() now excludes protectedGoods() in the first
   * place. Traders CAN hold contract goods; this is what makes that safe.
   */
  deliverCargo?: (ship: Ship) => Promise<true | string | null>;
  /** Units of `tradeSymbol` still outstanding across every accepted contract
   *  that wants it — used to cap a "contractBuy" purchase at what's actually
   *  still needed, not just cargo space/affordability/tradeVolume. Without
   *  this a ship topping off the last few units of a contract buys a full
   *  market-limit lot regardless, and is left holding the rest with nowhere
   *  to deliver it. */
  contractNeeded?: (tradeSymbol: string) => Promise<number>;
}


export interface WaypointPos {
  symbol: string;
  x: number;
  y: number;
  type?: components["schemas"]["WaypointType"];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

/**
 * A hauler/trader ship that executes buy-low → sell-high arbitrage routes.
 * Price knowledge is gathered by docking at markets (prices are only exposed
 * when a ship is present), so the trader keeps a running price table.
 */
export class TraderAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: TraderOptions["recordLedger"];
  private readonly onActivity: TraderOptions["onActivity"];
  private readonly recordMarket: TraderOptions["recordMarket"];
  private readonly getMarketSnapshots: TraderOptions["getMarketSnapshots"];
  private readonly protectedGoods?: () => Set<string>;
  private readonly reservedGoods?: () => Set<string>;
  private readonly assignedRoute?: () => TraderAssignment | undefined;
  private readonly claimRoute?: TraderOptions["claimRoute"];
  private readonly releaseRoute?: () => void;
  private readonly getCredits?: () => number;
  private readonly applyCashFloor?: (credits: number) => number;
  private readonly maxLossPct: number;
  private readonly marginFloor: number;
  private readonly intelMaxAgeMin: () => number;
  private readonly recordDoctrineFire?: TraderOptions["recordDoctrineFire"];
  private readonly atlas?: GalaxyAtlas;
  private readonly getWarehouseShip?: TraderOptions["getWarehouseShip"];
  private readonly warehouseBalance?: TraderOptions["warehouseBalance"];
  private readonly warehouseDeposit?: TraderOptions["warehouseDeposit"];
  private readonly warehouseWithdraw?: TraderOptions["warehouseWithdraw"];
  private readonly warehouseMinMargin?: TraderOptions["warehouseMinMargin"];
  private readonly intentFor?: TraderOptions["intentFor"];
  private readonly shouldRun?: () => boolean;
  private readonly recoverCostBasis?: TraderOptions["recoverCostBasis"];
  private readonly deliverCargo?: TraderOptions["deliverCargo"];
  private readonly contractNeeded?: TraderOptions["contractNeeded"];
  private readonly proxy: ShipProxy;
  /** Every `this.ship` read and write in this class goes through the one copy
   *  the proxy owns — see shipProxy.ts. */
  private get ship(): Ship { return this.proxy.getShip() as Ship; }
  private set ship(s: Ship) { this.proxy.setShip(s as never); }
  /** The world, held by reference — see registry.ts. */
  private registry: Registry = Registry.standalone();
  /** Good → price seen at each market. Rebuilt every tick by `loadSnapshots`. */
  private priceTable = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
  /** Prices this ship read live at a market, and when. Newer than the store. */
  private observed = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
  private observedAt = new Map<string, number>();
  private manualWaypoint: string | null = null;
  private suspended = false;
  /** The currently in-flight tick(), if any — suspend() awaits this so a caller
   *  about to mutate this ship's nav state directly (rescue/mission dispatch)
   *  can't race a tick that's already mid-flight against stale cached state. */
  private inFlight: Promise<unknown> | null = null;
  /** Good → cost basis per unit for cargo currently in the hold. */
  private heldCost = new Map<string, number>();
  /**
   * The leg a good in the hold was actually bought for, keyed by good.
   *
   * The dispatcher recomputes every 60s and may hand this ship a different
   * route for the same good mid-trip — in particular the second-best variant
   * keyed by sell destination. The leftover sweep read the *live* assignment,
   * so a ship that bought on one leg could find itself holding cargo for a
   * different, unreachable one. Live: DAGGER-17 bought 18u ANTIMATTER at
   * X1-KU72-I60 for a route selling at X1-KU72-I59, flew there, and then the
   * assignment mutated to the X1-TV75-X20F variant — a system it cannot reach
   * — after which the sweep deferred to that cross-system route on every tick
   * and the cargo was stranded.
   *
   * A trip is committed at the moment credits are spent. Pin the leg then and
   * read it back here, so what the ship does with cargo depends on why it
   * bought it, not on what the scheduler happens to want now.
   */
  private heldRoute = new Map<string, DirectLeg>();
  /** Routes rejected by the live buy-price guard this tick (good@buyAt). */
  private deadRoutes = new Set<string>();
  /** Legs whose far end the galaxy says cannot be reached at all — see the
   *  clear() in tick() for why these must outlive the per-tick sweep. */
  private unreachableRoutes = new Set<string>();
  private stranded = false;
  running = false;
  private get currentStep(): AgentStep { return this.proxy.getStep(); }
  private set currentStep(s: AgentStep) { this.proxy.setStep(s); }
  /** True only for the exact duration of a nextTask()-family run() closure's
   *  call into tick() — see agentStep.ts's NavigationPending doc comment for
   *  why this is scoped this narrowly rather than a flag set once and left
   *  true: dispatchTo() also reaches navigateTo(), directly from fleet.ts,
   *  never through tick(), and must keep blocking exactly as before. */
  private get schedulerDriven(): boolean { return this.proxy.schedulerDriven; }
  private set schedulerDriven(v: boolean) { this.proxy.schedulerDriven = v; }

  /** What this ship is doing right now, if it's mid-navigation or mid-transaction — see agentStep.ts. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: TraderOptions) {
    this.symbol = ship.symbol;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.getMarketSnapshots = opts.getMarketSnapshots;
    this.protectedGoods = opts.protectedGoods;
    this.reservedGoods = opts.reservedGoods;
    this.assignedRoute = opts.assignedRoute;
    this.claimRoute = opts.claimRoute;
    this.releaseRoute = opts.releaseRoute;
    this.getCredits = opts.getCredits;
    this.applyCashFloor = opts.applyCashFloor;
    this.maxLossPct = opts.maxLossPct ?? 15;
    this.marginFloor = opts.marginFloor ?? 10;
    this.intelMaxAgeMin = opts.intelMaxAgeMin ?? (() => 90);
    this.recordDoctrineFire = opts.recordDoctrineFire;
    this.atlas = opts.atlas;
    this.getWarehouseShip = opts.getWarehouseShip;
    this.warehouseBalance = opts.warehouseBalance;
    this.warehouseDeposit = opts.warehouseDeposit;
    this.warehouseWithdraw = opts.warehouseWithdraw;
    this.warehouseMinMargin = opts.warehouseMinMargin;
    this.intentFor = opts.intentFor;
    this.shouldRun = opts.shouldRun;
    this.recoverCostBasis = opts.recoverCostBasis;
    this.deliverCargo = opts.deliverCargo;
    this.contractNeeded = opts.contractNeeded;
    // Built last: it owns the ship state the `this.ship` accessor reads
    // through, so nothing may touch that accessor before this line.
    this.proxy = new ShipProxy(ship as never, {
      api: opts.api,
      registry: this.registry,
      log: this.log,
      onActivity: opts.onActivity,
      recordMarket: opts.recordMarket,
      recordLedger: opts.recordLedger,
      repairHere: opts.repairHere,
    });
  }

  isManual(): boolean {
    return this.manualWaypoint !== null;
  }

  /** True while the fleet holds the ship for coordinated work (rescue/mission). */
  isSuspended(): boolean {
    return this.suspended;
  }

  async dispatchTo(waypointSymbol: string): Promise<void> {
    this.manualWaypoint = waypointSymbol;
    this.log(`manual dispatch → ${waypointSymbol}`);
    await this.refresh();
    await this.navigateTo(waypointSymbol);
    await this.ensureDocked();
  }

  release(): void {
    if (this.manualWaypoint) {
      this.manualWaypoint = null;
      this.log("released to autonomous control");
    }
  }

  /**
   * Prevent the agent from acting while the fleet coordinates it manually
   * (e.g. rescues). Awaits any tick already in flight before returning — see
   * agent.ts's `suspend()` for why this matters: without it, a caller that
   * immediately mutates this ship's nav state directly via the raw API can
   * race a tick that's already mid-flight against stale cached ship state.
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

  /** Read the world from the fleet's live registry instead of a private copy. */
  withRegistry(registry: Registry): this {
    this.registry = registry;
    this.proxy.setRegistry(registry);
    return this;
  }

  /** Seed positions directly, for a trader with no shared registry. */
  withWorld(positions: WaypointPos[]): this {
    const standalone = this.registry as Registry & { seed?: (w: readonly WaypointPos[]) => void };
    standalone.seed?.(positions);
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
    this.proxy.setShip(ship as never);
  }

  private async refresh(): Promise<void> {
    return this.proxy.refresh();
  }

  private async ensureInOrbit(): Promise<void> {
    return this.proxy.ensureInOrbit();
  }

  private async ensureDocked(): Promise<void> {
    return this.proxy.ensureDocked();
  }

  private async waitForArrival(): Promise<void> {
    return this.proxy.waitForArrival();
  }

  private distBetween(a: string, b: string): number {
    return this.knownDistBetween(a, b) ?? 1000;
  }

  /**
   * Distance between two waypoints, or undefined when a position for either is
   * missing — as opposed to distBetween()'s pessimistic 1000, which is a
   * reasonable "assume far, don't bother" default for route scoring but a
   * fabricated number all the same.
   *
   * Callers that merely rank or reject options can live with the guess.
   * Anything that would *act* differently on it must not: 1000 exceeds every
   * fuel tank in the fleet, so chooseFlightMode() reads it as "can't afford
   * CRUISE" and returns DRIFT — which then succeeds and crawls. DAGGER-17
   * spent 7h34m in transit holding 20 units of EQUIPMENT on a leg measured
   * live at 172 units, with 598/600 fuel: it burned 2 fuel over seven hours,
   * the signature of a DRIFT that was never necessary.
   */
  private knownDistBetween(a: string, b: string): number | undefined {
    // Cross-system now reports unmeasurable rather than a meaningless hypot
    // across two unrelated coordinate spaces, which is what this method's own
    // callers already assumed: every one of them either guards on same-system
    // first, or only uses the result to reject. tripCost() reaches
    // distBetween() solely on its same-system branch, so the pessimistic 1000
    // it falls back to still never has to stand in for a jump.
    const d = this.registry.fuelFor(a, b);
    return Number.isFinite(d) ? d : undefined;
  }

  private systemOf(wp: string): string {
    return this.registry.systemOf(wp);
  }

  /** True if a leg between two systems is flyable right now: same system
   *  (no gate needed), or a cross-system gate GalaxyAtlas has cached as
   *  construction-complete. No atlas wired at all reads as "cross-system
   *  never reachable" — the same conservative default a standalone trader
   *  (no dispatcher, no atlas) already had before gate-awareness existed. */
  private systemsConnected(fromSystem: string, toSystem: string): boolean {
    return fromSystem === toSystem || (this.atlas?.canJump(fromSystem, toSystem) ?? false);
  }

  /** Nearest known fuel-selling waypoint (same system, reachable on a full
   *  tank from here) that makes real progress toward `destination` — the
   *  multi-hop equivalent of a direct navigateTo() for a leg beyond the
   *  tank's single-hop range. Only considers markets already in
   *  `priceTable` (this fleet's own known intel, not a live galaxy-wide
   *  search) — same scope as every other route decision this agent makes.
   *  Returns undefined if no such stop exists: a route that can't work no
   *  matter how many hops, not just "hasn't found a good one yet". */
  private nextHopToward(destination: string): string | undefined {
    const here = this.ship.nav.waypointSymbol;
    const system = this.systemOf(here);
    const budget = this.ship.fuel.capacity;
    const stops = [...this.priceTable.entries()]
      .filter(([wp, goods]) => wp !== here && wp !== destination && this.systemOf(wp) === system && (goods.get("FUEL")?.buy ?? 0) > 0)
      .map(([wp]) => wp)
      .filter((wp) => this.distBetween(here, wp) <= budget);
    if (stops.length === 0) return undefined;
    stops.sort((a, b) => this.distBetween(a, destination) - this.distBetween(b, destination));
    return stops[0];
  }

  private async navigateTo(waypoint: string): Promise<void> {
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") return;
    const targetSystem = this.systemOf(waypoint);
    if (targetSystem !== this.ship.nav.systemSymbol) {
      await this.jumpToSystem(targetSystem, waypoint);
      return;
    }
    // Refuel if we're low. Prefer a market, but burn FUEL from the cargo hold
    // when there's no market here — a trader hauling fuel must never be stranded
    // at a non-market waypoint (e.g. an asteroid) while carrying its own fuel.
    // Never refuel while in transit — refuelAt() calls navigateTo() again, and a
    // ship that is IN_TRANSIT to a fuel market would recurse forever.
    if (this.ship.nav.status !== "IN_TRANSIT" && this.ship.fuel.current < this.ship.fuel.capacity * 0.5) {
      const here = this.ship.nav.waypointSymbol;
      const isFuelMarket = this.priceTable.get(here)?.has("FUEL");
      if (isFuelMarket) {
        await this.refuelAt(here);
      } else {
        await this.refuelFromCargo();
      }
    }
    // Everything from here is the shared in-system primitive: the post-orbit
    // re-check, the flight-mode decision, the navigate call and the
    // already-there recovery all live in ShipProxy now, because this file and
    // the other three each carried a copy that had drifted apart. What stays
    // here is what is genuinely this class's own: the jump branch above and
    // the pre-departure refuel.
    await this.proxy.navigateTo(waypoint);
  }

  private async waitCooldown(): Promise<void> {
    return this.proxy.waitCooldown();
  }

  /** Jump to a waypoint in another system using the nearest jump gate. */
  /**
   * Refuse to transact anywhere but where the plan says the ship is.
   *
   * Rule 4 of docs/control-plane-data-plane.md — "status is written by the
   * thing that observed it" — applied one level down, inside the agent. A
   * trade is a straight-line procedure (navigate, dock, buy, navigate, dock,
   * sell) with no diff between statements, so a movement that quietly failed
   * left every later statement acting on the plan's waypoint instead of the
   * ship's. DAGGER-F bought at "X1-RD37-D20E" and sold at "X1-TV75-X20F"
   * while parked in X1-ZU53, losing 9,036c a cycle, and every log line about
   * it was false.
   *
   * jumpToSystem() now throws rather than returning silently, which closes
   * the case that actually bit. This closes the class: mission.ts and
   * stepRescue() are safe because they re-check position before every step
   * and simply make no progress on a failed move. This is that same
   * precondition for the one role that runs straight through.
   *
   * The check itself moved to ShipProxy once the miner and siphoner needed
   * the same guarantee — it asks where the ship is, which is the proxy's
   * question, not this class's. This stays as the trader's name for it so
   * the six call sites below read the way they always did.
   */
  private assertAt(waypoint: string, action: string): void {
    this.proxy.assertAt(waypoint, action);
  }

  /**
   * Retire the assigned route when the galaxy says its far end cannot be
   * reached at all. Without this the throw above is honest but useless: the
   * dispatcher re-assigns the identical leg next tick and the ship fails on it
   * forever, which is the same loop with an error line instead of a loss.
   */
  private markRouteUnreachable(targetSystem: string): void {
    // Either end. The unreachable system is as often the one a leg starts in
    // as the one it ends in, and retiring only on the sell end left every
    // buy-side case looping.
    const leg = this.asDirectLeg(this.assignedRoute?.());
    if (!leg) return;
    if (this.systemOf(leg.sellAt) === targetSystem || this.systemOf(leg.buyAt) === targetSystem) {
      this.deadRoutes.add(`${leg.good}@${leg.buyAt}`);
      this.unreachableRoutes.add(`${leg.good}@${leg.buyAt}`);
    }
  }

  /**
   * Every failure below throws. It used to log and return, which reads to the
   * caller exactly like a successful arrival — and the caller's next moves are
   * ensureDocked(), liveSellPrice(route.sellAt) and a purchase or sale. So a
   * ship that never moved bought and sold at whatever market it was actually
   * standing on, while the logs named the route's waypoints.
   *
   * Live, DAGGER-F ran this ~every 45 seconds for over twenty minutes: sitting
   * in X1-ZU53, "no jump gate from X1-ZU53 to X1-TV75", then "bought 18u
   * ANTIMATTER @ 5919c at X1-RD37-D20E" and "sold 18u ANTIMATTER @ 5417c at
   * X1-TV75-X20F" — two markets in two other systems, neither of which it was
   * at — losing 9,036c a cycle. Roughly a quarter of a million credits, and
   * every log line about it was false.
   *
   * A movement primitive that cannot move the ship must not return normally.
   */
  private async jumpToSystem(targetSystem: string, destination: string): Promise<void> {
    if (!this.atlas) {
      throw new Error(`cannot jump to ${targetSystem}: no galaxy atlas`);
    }
    await this.waitCooldown();
    const fromSystem = this.ship.nav.systemSymbol;
    const gates = this.atlas.gatesTo(fromSystem, targetSystem);
    let gate = gates[0];
    if (!gate) {
      await this.atlas.scanJumpGates(fromSystem);
      gate = this.atlas.gatesTo(fromSystem, targetSystem)[0];
    }
    if (!gate) {
      this.markRouteUnreachable(targetSystem);
      throw new Error(`no jump gate from ${fromSystem} to ${targetSystem}`);
    }
    // Guard against infinite recursion: the gate must be in the current system.
    // If the atlas returns a gate in a different system (stale state after a
    // jump), navigating to it would call jumpToSystem again forever.
    if (this.systemOf(gate) !== fromSystem) {
      throw new Error(`gate ${gate} is not in ${fromSystem}; cannot jump to ${targetSystem}`);
    }
    // The jump endpoint's target must be the destination system's own jump
    // gate waypoint — it never accepts an arbitrary waypoint in that system.
    // Passing `destination` straight through only ever worked when it
    // happened to *be* the gate (an antimatter market often sits right on
    // one). Confirmed live: the return leg of a route whose destination
    // wasn't the gate (back to a buy market elsewhere in the home system)
    // failed outright with "Waypoint ... is not connected to the current
    // location", stranding the ship at the far system, repeating the same
    // failed jump every poll with no progress.
    const remoteSystem = await this.atlas.loadSystem(targetSystem);
    const remoteGate = remoteSystem.waypoints.find((w) => w.type === "JUMP_GATE")?.symbol;
    if (!remoteGate) {
      this.markRouteUnreachable(targetSystem);
      throw new Error(`${targetSystem} has no jump gate waypoint`);
    }
    await this.navigateTo(gate);
    await this.ensureInOrbit();
    this.log(`jumping ${fromSystem} -> ${targetSystem} via ${gate}`);
    const res = await this.api.jumpShip(this.symbol, remoteGate);
    this.ship = { ...this.ship, nav: res.nav };
    this.onActivity?.("jump", `jumped to ${remoteGate}`, -res.transaction.totalPrice, this.symbol);
    // The only place a real jump cost is ever known — feeds tripCost()'s
    // learned-average estimate for future routes over this same gate/
    // destination-system pair. See GalaxyAtlas.recordJumpCost()'s own comment.
    this.atlas?.recordJumpCost(gate, targetSystem, res.transaction.totalPrice);
    await this.refresh();
    if (this.recordMarket) await this.recordMarket(this.ship.nav.waypointSymbol);
    // The jump only gets us to the gate — if the real destination is
    // somewhere else in the target system, cover that last leg too.
    if (destination !== remoteGate) await this.navigateTo(destination);
  }

  /** Dock at a waypoint and refresh prices for its market. */
  private async observeMarket(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    if (this.recordMarket) await this.recordMarket(waypoint);
    const m = await this.api.getMarket(this.ship.nav.systemSymbol, waypoint);
    const table = new Map<string, { buy: number; sell: number; volume: number }>();
    for (const g of m.tradeGoods ?? []) {
      table.set(g.symbol, { buy: g.purchasePrice, sell: g.sellPrice, volume: g.tradeVolume });
    }
    this.observed.set(waypoint, table);
    this.observedAt.set(waypoint, Date.now());
    const merged = this.priceTable.get(waypoint) ?? new Map();
    for (const [good, price] of table) merged.set(good, price);
    this.priceTable.set(waypoint, merged);
  }

  /** Best buy location + price for a good among observed markets. */
  private bestBuy(good: string): { waypoint: string; buy: number; sell: number; volume: number } | undefined {
    let best: { waypoint: string; buy: number; sell: number; volume: number } | undefined;
    for (const [wp, table] of this.priceTable) {
      const g = table.get(good);
      if (!g) continue;
      if (!best || g.buy < best.buy) best = { waypoint: wp, ...g };
    }
    return best;
  }

  /** Best sell location + price for a good among observed markets. */
  private bestSell(good: string): { waypoint: string; buy: number; sell: number; volume: number } | undefined {
    let best: { waypoint: string; buy: number; sell: number; volume: number } | undefined;
    for (const [wp, table] of this.priceTable) {
      const g = table.get(good);
      if (!g) continue;
      if (!best || g.sell > best.sell) best = { waypoint: wp, ...g };
    }
    return best;
  }

  /** Live sell price at a market, or undefined if the market is unreachable. */
  private async liveSellPrice(waypoint: string, good: string): Promise<number | undefined> {
    try {
      const m = await this.api.getMarket(this.systemOf(waypoint), waypoint);
      const g = m.tradeGoods?.find((t) => t.symbol === good);
      return g?.sellPrice;
    } catch {
      return undefined;
    }
  }

  /** Live purchase price at a market, or undefined if the market is unreachable. */
  private async liveBuyPrice(waypoint: string, good: string): Promise<number | undefined> {
    try {
      const m = await this.api.getMarket(this.systemOf(waypoint), waypoint);
      const g = m.tradeGoods?.find((t) => t.symbol === good);
      return g?.purchasePrice;
    } catch {
      return undefined;
    }
  }

  /**
   * What this ship paid per unit for a good it's holding.
   *
   * `heldCost` only lives as long as the process, so a restart used to leave it
   * empty — and an empty basis meant `exceedsLossFloor` returned false for
   * everything, i.e. no loss protection at all. Every ship holding cargo across
   * a restart therefore sold it at whatever the market offered on its first
   * tick. The trade ledger has the answer, so recover from it and memoize.
   *
   * A good with genuinely no purchase history — mined ore, siphoned gas — still
   * returns undefined, and *should*: it has no cost basis to protect, so it may
   * sell at any price. That's the meaningful distinction the old code couldn't
   * make, because "never bought" and "forgot what we paid" looked identical.
   */
  private async costBasis(good: string): Promise<number | undefined> {
    const known = this.heldCost.get(good);
    if (known !== undefined && known > 0) return known;
    const recovered = await this.recoverCostBasis?.(good);
    if (recovered !== undefined && recovered > 0) {
      this.heldCost.set(good, recovered);
      this.log(`recovered cost basis for ${good}: ${Math.round(recovered)}c (from trade ledger)`);
      return recovered;
    }
    return undefined;
  }

  /** True when selling at `price` would exceed the allowed loss vs the cost basis. */
  private async exceedsLossFloor(good: string, price: number): Promise<boolean> {
    const cost = await this.costBasis(good);
    if (cost === undefined || cost <= 0) return false;
    const floor = cost * (1 - this.maxLossPct / 100);
    return price < floor;
  }

  /**
   * The route this trader should fly next.
   *
   * Order matters, and it is the whole convergence fix:
   *
   * 1. The route the dispatcher already gave us — good *and* markets, so we fly
   *    the leg it priced rather than re-deriving our own from a price table
   *    that may disagree with it.
   * 2. Failing that, claim the best route no fleetmate holds. The claim is one
   *    synchronous call into the dispatcher, so two traders evaluating routes
   *    at the same moment cannot both walk away with the same good.
   * 3. Only when no dispatcher is wired at all (standalone trader) do we fall
   *    back to picking for ourselves.
   */
  private findRoute(): Route | undefined {
    const assigned = this.asDirectLeg(this.assignedRoute?.());
    if (assigned) {
      const viable = this.viableRoute(assigned);
      if (viable) return viable;
    }

    if (this.claimRoute) {
      const claimed = this.asDirectLeg(this.claimRoute((r) => this.viableRoute(r) !== undefined));
      return claimed ? this.viableRoute(claimed) : undefined;
    }

    return this.freeChoice();
  }

  /**
   * Narrow a dispatcher assignment down to a direct leg this ship can
   * evaluate. A "buy"/"sell"/"haul" assignment reads as "nothing for the
   * direct pipeline" rather than crashing on the missing buyAt/sellAt —
   * those roles are handled by runBuy/runSell instead.
   */
  private asDirectLeg(a: TraderAssignment | undefined): DirectLeg | undefined {
    if (!a || a.role !== "direct" || !a.buyAt || !a.sellAt || a.buyPrice === undefined || a.sellPrice === undefined) {
      return undefined;
    }
    return { good: a.good, buyAt: a.buyAt, sellAt: a.sellAt, buyPrice: a.buyPrice, sellPrice: a.sellPrice };
  }

  /**
   * Turn a direct leg into something this ship can actually fly, or
   * undefined if it can't: wrong system, no prices for those markets, margin
   * below the floor, nothing affordable, or fuel eats the profit.
   */
  private viableRoute(r: DirectLeg): Route | undefined {
    if (r.buyAt === r.sellAt) return undefined;
    if (this.protectedGoods?.().has(r.good)) return undefined;
    if (this.deadRoutes.has(`${r.good}@${r.buyAt}`)) return undefined;
    const buySystem = this.systemOf(r.buyAt);
    const sellSystem = this.systemOf(r.sellAt);
    const crossSystem = buySystem !== sellSystem;
    // Cross-system is flyable once the connecting gate is complete —
    // GalaxyAtlas.canJump() is the one place that answers that, backed by a
    // cache FleetManager.tick() refreshes on a slow interval rather than a
    // live call from this hot scoring path.
    if (!this.systemsConnected(buySystem, sellSystem)) return undefined;
    // ...and that this ship can reach the *start* of the leg.
    //
    // The check above, and the dispatcher's matching one, validate buy↔sell:
    // the pair the route is made of. Neither validates here→buy, which is the
    // leg the ship flies first. So a route whose two ends connect to each
    // other but not to the hull scored as viable, got assigned, and failed at
    // the jump every time. Live, that put all six traders into a ~20-second
    // error loop with nothing completing at all: X1-RD37 was surveyed, its
    // fresh spreads took over the top of the dispatcher's value list, and
    // ships standing in X1-KU72 and X1-ZU53 were handed routes starting in a
    // system none of them could reach.
    //
    // systemsConnected() is single-hop, and so is the executor: jumpToSystem()
    // takes gatesTo(from, target)[0] and jumps once. This filter is therefore
    // exactly as capable as the ship it governs — a two-hop system is not
    // being wrongly excluded, it is genuinely unflyable until multi-hop
    // routing exists.
    if (!this.systemsConnected(this.systemOf(this.ship.nav.waypointSymbol), buySystem)) return undefined;
    // A leg whose distance exceeds the ship's own fuel tank capacity can never
    // be flown, no matter how full the tank is — this is distinct from "not
    // enough fuel right now" (which a refuel fixes). Confirmed in production:
    // a full (80/80) ship still got "requires 16 more fuel for navigation"
    // trying to fly a leg that needed 96. Check both legs a "direct" route
    // actually requires: here → buyAt, and buyAt → sellAt.
    //
    // distBetween() only means anything within one system's own coordinate
    // space — a gate crossing is a jumpShip() call, not a fuel-tank-bound
    // navigate, so any leg that crosses a system boundary skips this check
    // entirely rather than comparing two unrelated coordinate spaces.
    if (this.ship.fuel.capacity > 0) {
      if (this.systemOf(this.ship.nav.waypointSymbol) === buySystem &&
          this.distBetween(this.ship.nav.waypointSymbol, r.buyAt) > this.ship.fuel.capacity) return undefined;
      if (!crossSystem && this.distBetween(r.buyAt, r.sellAt) > this.ship.fuel.capacity) return undefined;
    }
    const buy = this.priceTable.get(r.buyAt)?.get(r.good);
    const sell = this.priceTable.get(r.sellAt)?.get(r.good);
    if (!buy || !sell || buy.buy <= 0) return undefined;
    const margin = sell.sell - buy.buy;
    if (margin <= this.marginFloor) {
      this.recordDoctrineFire?.("marginFloor");
      return undefined;
    }
    const credits = this.getCredits?.() ?? Infinity;
    const affordable = credits > 0 ? Math.floor(credits / buy.buy) : Infinity;
    const volume = Math.min(buy.volume, sell.volume, this.ship.cargo.capacity, affordable);
    if (volume <= 0) return undefined;
    const route: Route = { good: r.good, buyAt: r.buyAt, buyPrice: buy.buy, sellAt: r.sellAt, sellPrice: sell.sell, margin, volume };
    if (this.routeProfit(route) <= 0) return undefined;
    return route;
  }

  /**
   * Pick the most profitable good for ourselves. Only reachable when no
   * dispatcher is wired — with one, allocation goes through `claimRoute`,
   * because this path is a read-modify-write race: `reservedGoods` reflects
   * cargo already in holds, so two traders in here at the same time both see
   * the same good as free and both take it.
   */
  private freeChoice(): Route | undefined {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const reservedGoods = this.reservedGoods?.() ?? new Set<string>();
    const goods = new Set<string>();
    for (const table of this.priceTable.values()) for (const g of table.keys()) goods.add(g);
    let best: Route | undefined;

    for (const good of goods) {
      if (protectedGoods.has(good) || reservedGoods.has(good)) continue;
      const buy = this.bestBuy(good);
      const sell = this.bestSell(good);
      if (!buy || !sell) continue;
      if (sell.waypoint === buy.waypoint) continue;
      if (this.deadRoutes.has(`${good}@${buy.waypoint}`)) continue;
      const buySystem = this.systemOf(buy.waypoint);
      const sellSystem = this.systemOf(sell.waypoint);
      // Cross-system is flyable once the connecting gate is complete — see
      // viableRoute()'s own comment on why this reads a cache rather than
      // making a live call from this scoring loop.
      if (!this.systemsConnected(buySystem, sellSystem)) continue;
      const margin = sell.sell - buy.buy;
      if (margin <= this.marginFloor) {
        this.recordDoctrineFire?.("marginFloor");
        continue;
      }
      const credits = this.getCredits?.() ?? Infinity;
      const affordable = credits > 0 ? Math.floor(credits / buy.buy) : Infinity;
      const volume = Math.min(buy.volume, sell.volume, this.ship.cargo.capacity, affordable);
      if (volume <= 0) continue;
      const candidate: Route = {
        good,
        buyAt: buy.waypoint,
        buyPrice: buy.buy,
        sellAt: sell.waypoint,
        sellPrice: sell.sell,
        margin,
        volume,
      };
      const profit = this.routeProfit(candidate);
      if (profit <= 0) continue;
      if (!best || profit > this.routeProfit(best)) best = candidate;
    }
    return best;
  }

  /** The trip cost half of a route's profit: same-system fuel burn, or —
   *  since buyAt/sellAt coordinates live in unrelated per-system spaces
   *  once they cross a gate, and jumpShip() charges credits directly rather
   *  than fuel-tank units — a jump-cost estimate for a cross-system leg.
   *  jumpToSystem() records what every real jump actually cost as it
   *  happens (GalaxyAtlas.recordJumpCost()); this prefers that learned
   *  average over the same gate/destination-system pair, falling back to
   *  the flat CROSS_SYSTEM_JUMP_COST_ESTIMATE placeholder only when this
   *  fleet has never actually paid for that jump before. */
  private tripCost(buyAt: string, sellAt: string): number {
    const buySystem = this.systemOf(buyAt);
    const sellSystem = this.systemOf(sellAt);
    if (buySystem !== sellSystem) {
      const gate = this.atlas?.gatesTo(buySystem, sellSystem)[0];
      const learned = gate ? this.atlas?.learnedJumpCost(gate, sellSystem) : undefined;
      return learned ?? CROSS_SYSTEM_JUMP_COST_ESTIMATE;
    }
    const fuelPrice = this.priceTable.get(buyAt)?.get("FUEL")?.buy ?? 72;
    return this.distBetween(buyAt, sellAt) * fuelPrice;
  }

  private routeProfit(r: Route): number {
    return (r.sellPrice - r.buyPrice) * r.volume - this.tripCost(r.buyAt, r.sellAt);
  }

  private async refuelAt(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    const fuelNeeded = this.ship.fuel.capacity - this.ship.fuel.current;
    if (fuelNeeded > 0) {
      const res = await this.api.refuelShip(this.symbol);
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "REFUEL",
        units: res.fuel.current,
        total: res.transaction.totalPrice,
      });
    }
  }

  /** Top up the tank from FUEL carried in the cargo hold (no market needed).
   *  Returns true if the tank gained any fuel. */
  private async refuelFromCargo(): Promise<boolean> {
    const fuel = this.ship.cargo.inventory?.find((i) => i.symbol === "FUEL");
    if (!fuel || fuel.units <= 0) return false;
    const room = this.ship.fuel.capacity - this.ship.fuel.current;
    if (room <= 0) return false;
    const use = Math.min(fuel.units, room);
    await this.api.refuelShip(this.symbol, undefined, true);
    await this.refresh();
    this.log(`refueled ${use}u from cargo hold`);
    return true;
  }

  /**
   * Rebuild the price table from the store's snapshots.
   *
   * This *replaces* the table rather than merging into it. Merging meant a
   * price the fleet had since aged out of its freshness window lived on in
   * memory forever, so the trader kept planning routes the dispatcher no
   * longer believed in — the two ended up flying different maps. Prices we
   * observed live at a market this tick are re-applied on top, since those are
   * fresher than anything the store has.
   */
  private async loadSnapshots(): Promise<void> {
    const snaps = (await this.getMarketSnapshots?.()) ?? [];
    const next = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
    for (const s of snaps) {
      const table = next.get(s.waypointSymbol) ?? new Map();
      table.set(s.goodSymbol, { buy: s.purchasePrice, sell: s.sellPrice, volume: s.tradeVolume });
      next.set(s.waypointSymbol, table);
    }
    const cutoff = Date.now() - this.intelMaxAgeMin() * 60_000;
    for (const [wp, table] of this.observed) {
      if ((this.observedAt.get(wp) ?? 0) < cutoff) {
        this.recordDoctrineFire?.("snapshotMaxAgeMin");
        this.observed.delete(wp);
        this.observedAt.delete(wp);
        continue;
      }
      const merged = next.get(wp) ?? new Map();
      for (const [good, price] of table) merged.set(good, price);
      next.set(wp, merged);
    }
    this.priceTable = next;
  }

  /**
   * Sweep cargo already sitting in the hold (crash recovery, or a leftover
   * deposit that failed to reach the warehouse ship) before evaluating new
   * routes this tick. Sells at the best same-system market — including the
   * current route's good; excluding it used to let a trader sit at the sell
   * market holding cargo while route logic kept flying it back for more.
   * Returns a tick result if it handled everything, or undefined to fall
   * through to routing — e.g. when docking failed and the cargo is still
   * stuck in the hold.
   */
  private async clearLeftoverCargo(): Promise<boolean | undefined> {
    // Mission materials and contract-deliverable goods must never be swept
    // here — a contract good in particular is normally already routed away
    // by the deliverCargo check earlier in tick(), before this ever runs;
    // this is the defense-in-depth backstop for the rest (mission materials,
    // or a contract good held when no deliverCargo hook was wired in at
    // all). Previously this function had no protectedGoods check whatsoever,
    // so any of them landing in a trader's hold got sold — or jettisoned,
    // if no market would buy it — on the very next tick.
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const held = new Set<string>((this.ship.cargo.inventory ?? []).filter((i) => i.units > 0).map((i) => i.symbol));
    // A pin must never outlive the cargo it describes: once the good is gone
    // the trip is over, and a stale leg would answer for the next one.
    for (const good of [...this.heldRoute.keys()]) if (!held.has(good)) this.heldRoute.delete(good);
    const leftover = (this.ship.cargo.inventory ?? []).filter((i) => i.units > 0 && !protectedGoods.has(i.symbol));
    if (leftover.length === 0) return undefined;
    const item = leftover[0]!;
    // Cargo bought a moment ago for an active route is not "leftover".
    //
    // runArbitrage() buys, navigates and sells inside one tick — but
    // navigateTo() raises NavigationPending the moment the ship enters
    // transit, so the tick ends right after the buy and the sell leg never
    // runs. On the next tick this sweep goes first (tick() calls it ahead of
    // every role handler) and sells the route's cargo itself, at bestSell()'s
    // local pick rather than the destination the route was chosen for. That
    // is why production shows "bought 20u MACHINERY ... / cleared leftover 20u
    // MACHINERY" pairs and no "sold" lines at all: every route is being
    // finished by the cleanup path.
    //
    // For a same-system route the two usually agree, so little is lost. For a
    // cross-system one they do not: the sweep below refuses to leave the
    // system, so the cargo gets dumped at local prices and the jump leg the
    // route was actually worth is abandoned. Hand those back to the route
    // logic instead. Cargo with no live route behind it still gets swept,
    // which is what this function is for.
    // Cargo on a live trip belongs to deliverHeldCargo(), which reconciles it
    // against the leg it was bought for. This function is for cargo with no
    // trip behind it — crash recovery, a failed warehouse deposit — which is
    // what its name says and, before step 3 landed, was not what it did: it
    // finished every route, at bestSell()'s local pick rather than the
    // destination the route was chosen for.
    if (this.heldRoute.has(item.symbol)) return undefined;
    const activeLeg = this.asDirectLeg(this.assignedRoute?.());
    if (activeLeg && activeLeg.good === item.symbol && this.systemOf(activeLeg.sellAt) !== this.ship.nav.systemSymbol) {
      this.log(`leftover sweep: leaving ${item.units}u ${item.symbol} to its cross-system route (sells at ${activeLeg.sellAt})`);
      return undefined;
    }
    // Only sell leftover within the current system — a cross-system sell
    // market needs a jump gate that may be under construction, and flying
    // there would fail (or worse, recurse in navigation). Prefer the active
    // route's own destination when it is in reach: it is the market the route
    // was ranked on, and bestSell() has no knowledge of that intent.
    const routeSellHere =
      activeLeg && activeLeg.good === item.symbol && this.systemOf(activeLeg.sellAt) === this.ship.nav.systemSymbol
        ? activeLeg.sellAt
        : undefined;
    const sell = routeSellHere ? { waypoint: routeSellHere } : this.bestSell(item.symbol);
    if (sell && sell.waypoint !== this.ship.nav.waypointSymbol && this.systemOf(sell.waypoint) === this.ship.nav.systemSymbol) {
      await this.navigateTo(sell.waypoint);
    }
    // Say which of the two things this is. Both paths end in the same
    // "cleared leftover" line below, so from the log alone there was no way to
    // tell a route being completed at its own ranked destination from orphaned
    // cargo being dumped at whatever is nearest — including no way to check
    // whether preferring routeSellHere actually changed anything.
    const disposition = routeSellHere
      ? `completing ${item.symbol} route at its own destination ${routeSellHere}`
      : `no live route for ${item.symbol}; dumping at ${sell?.waypoint ?? this.ship.nav.waypointSymbol}`;
    this.log(`leftover sweep: ${disposition}`);
    // Dock before selling — a ship sitting in orbit at a market would
    // otherwise skip the sell and fall through to buying MORE cargo.
    await this.ensureDocked();
    if (this.ship.nav.status !== "DOCKED") return undefined;
    try {
      const live = await this.liveSellPrice(this.ship.nav.waypointSymbol, item.symbol);
      if (live !== undefined && (await this.exceedsLossFloor(item.symbol, live))) {
        this.recordDoctrineFire?.("maxLossPct");
        this.log(`holding ${item.units}u ${item.symbol}: live sell ${live}c is below loss floor (cost ${this.heldCost.get(item.symbol)}c)`);
        return true;
      }
      this.currentStep = { kind: "transacting", action: "sell", good: item.symbol };
      const sold = await this.api.sellCargo(this.symbol, item.symbol, item.units);
      this.currentStep = IDLE_STEP;
      this.ship = { ...this.ship, cargo: sold.cargo };
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "SELL",
        tradeSymbol: item.symbol,
        units: item.units,
        pricePerUnit: sold.transaction.pricePerUnit,
        total: sold.transaction.totalPrice,
      });
      this.log(`cleared leftover ${item.units}u ${item.symbol} @ ${sold.transaction.pricePerUnit}c at ${this.ship.nav.waypointSymbol}`);
      this.onActivity?.("sell", `${item.units}u ${item.symbol} @ ${sold.transaction.pricePerUnit}c`, sold.transaction.totalPrice, this.symbol);
      return true;
    } catch (err) {
      // market doesn't buy it — jettison to free the hold
      this.currentStep = { kind: "transacting", action: "jettison", good: item.symbol };
      const j = await this.api.jettisonCargo(this.symbol, item.symbol, item.units);
      this.currentStep = IDLE_STEP;
      this.ship = { ...this.ship, cargo: j.cargo };
      this.log(`jettisoned ${item.units}u ${item.symbol} (no buyer)`);
      return true;
    }
  }

  /**
   * Whether this ship can actually get to `waypoint` right now: same system
   * (no gate needed), or a cross-system gate that's both known AND not
   * still under construction. atlas.gatesTo() only reports a gate's
   * *connections* — JumpGate objects carry no construction status at all,
   * that lives on the waypoint (isUnderConstruction) — so a gate symbol
   * being known doesn't mean the jump will actually succeed; a genuinely
   * observed case (a home-system gate mid-build) had a real gate connection
   * on record while still being unusable. Goes through
   * GalaxyAtlas.refreshGateConstruction() (cache-aware: only makes a live
   * call when this gate isn't already confirmed complete) rather than its
   * own fetch, so this agrees with — and shares a cache with —
   * systemsConnected()'s hot-path checks and fleet.ts's exploreSystem()/
   * scoutCanReachUncharted().
   */
  private async canReachMarket(waypoint: string): Promise<boolean> {
    const targetSystem = this.systemOf(waypoint);
    const hereSystem = this.ship.nav.systemSymbol;
    if (targetSystem === hereSystem) {
      // Reachable requires more than "no gate needed" — the leg still has to
      // fit in the tank. Same class of bug as viableRoute()'s own capacity
      // check: a same-system market can still be farther than this ship can
      // ever carry enough fuel to reach.
      if (this.ship.fuel.capacity > 0 && this.distBetween(this.ship.nav.waypointSymbol, waypoint) > this.ship.fuel.capacity) return false;
      return true;
    }
    const gate = this.atlas?.gatesTo(hereSystem, targetSystem)[0];
    if (!gate) return false;
    return (await this.atlas?.refreshGateConstruction(hereSystem, gate)) ?? false;
  }

  /**
   * No profitable route right now: refresh prices instead of sleeping and
   * retrying the same dead route forever. `preferred` is checked first (the
   * markets the caller actually wanted fresh intel on), then any other known
   * market — same-system candidates before cross-system ones, so the common
   * case never even calls canReachMarket()'s gate-construction check.
   *
   * `preferred` only needs to be *reachable*, not already `knownMarkets` —
   * requiring it to already have a fresh snapshot defeated the entire point
   * of this function for exactly its main caller: runArbitrage() passes the
   * dispatcher's assigned buyAt/sellAt here specifically when viableRoute()
   * rejected the assignment for lacking a cached price at that market (see
   * viableRoute()'s own priceTable.get() check). Previously that market got
   * silently filtered out of its own "go observe it" candidate list, so a
   * freshly (re)assigned route the trader had never priced yet meant this
   * returned false with no log line and no action — reported live as a
   * trader sitting idle and silent for minutes after being released, still
   * holding an assignment it could never act on.
   *
   * Previously this also picked *any* known market fleet-wide with no
   * reachability check at all, so a market in a system with no completed
   * gate connection got picked, jumpToSystem() silently no-op'd (logged "no
   * jump gate...", didn't throw), and this function still returned true —
   * reporting the tick as having made progress, which chained the next
   * attempt with ZERO backoff (nextTask() only backs off when made=false).
   * That's a busy loop, not just a slow retry, and it picks the exact same
   * unreachable market again every pass since knownMarkets' ordering
   * doesn't change.
   */
  private async discoverPrices(preferred: string[]): Promise<boolean> {
    const here = this.ship.nav.waypointSymbol;
    const hereSystem = this.ship.nav.systemSymbol;
    const knownMarkets = [...new Set(((await this.getMarketSnapshots?.()) ?? []).map((s) => s.waypointSymbol))].filter((m) => m !== here);
    const sameSystem = knownMarkets.filter((m) => this.systemOf(m) === hereSystem);
    const crossSystem = knownMarkets.filter((m) => this.systemOf(m) !== hereSystem);
    const candidates = [...new Set([...preferred.filter((m) => m && m !== here), ...sameSystem, ...crossSystem])];

    let target: string | undefined;
    for (const m of candidates) {
      if (await this.canReachMarket(m)) {
        target = m;
        break;
      }
    }
    if (!target) return false;

    this.log("discovering prices...");
    // Navigate to the market first, then refuel there — refueling at the
    // current spot fails if it's an asteroid with no fuel market.
    await this.navigateTo(target);
    await this.refuelAt(target);
    await this.observeMarket(target);
    return true;
  }

  /** The legacy direct buy→sell pipeline: one ship owns the whole round
   *  trip. Used for "direct"/unassigned traders, and as the fallback when a
   *  buy/sell-role assignment can't be flown (e.g. no warehouse ship yet). */
  /**
   * Step 3 of docs/control-plane-data-plane.md, for the one role that never
   * got it: deliver whatever this ship is already carrying, derived from
   * observed state rather than from where a procedure left off.
   *
   * A trade used to run straight through — navigate, dock, buy, navigate,
   * dock, sell — with no diff between statements. Under the scheduler that
   * shape cannot even complete: navigateTo() raises NavigationPending the
   * moment the ship enters transit, so the tick ended right after the buy and
   * the sell half never ran. The leftover sweep finished the route instead,
   * at whatever market was nearest rather than the one the route was chosen
   * for, which is why production showed "bought 20u X / cleared leftover 20u
   * X" pairs and almost no "sold" lines at all.
   *
   * Here the trip is re-derived every tick from two observed facts: what is in
   * the hold, and where the ship is standing. Arrival is explicit because it
   * is the precondition for selling rather than an assumption inherited from
   * the statement above. A move that fails simply makes no progress this tick,
   * exactly as MissionManager.stepCarrier() has always behaved.
   *
   * Returns undefined when there is nothing under way, so the caller falls
   * through to starting a new trip.
   */
  /**
   * Credits this ship may actually commit to a purchase.
   *
   * Live, because the fleet's cached balance is refreshed once per tick and
   * goes stale the moment another ship spends — that staleness is why these
   * sites read the agent directly in the first place, and dropping the live
   * read to get the floor back would just trade one bug for the other.
   *
   * Floored, because `cashFloor` is doctrine and says so plainly: "the
   * catch-all floor for every purchase (ships, modules, repairs, cargo).
   * Fuel is always exempt." It was adopted, enabled and enforced, and the
   * three purchase sites below simply never consulted it — a fleet holding
   * ~11,400c against a 20,000c floor bought 1u DRUGS for 11,328c, leaving
   * about a hundred credits. It was already under the floor before it
   * bought.
   *
   * One method rather than the floor being reapplied at each call site: the
   * bug was three places reading a different source than the design
   * nominated, and adding a fourth thing for each of them to remember would
   * be the same shape of mistake.
   */
  private async spendableNow(): Promise<number> {
    const live = (await this.api.getMyAgent()).credits;
    return this.applyCashFloor ? this.applyCashFloor(live) : live;
  }

  private async deliverHeldCargo(): Promise<boolean | undefined> {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    for (const item of this.ship.cargo.inventory ?? []) {
      if (item.units <= 0 || protectedGoods.has(item.symbol)) continue;
      // The leg it was bought for, not the one the dispatcher wants now — see
      // heldRoute. Cargo with no pin is genuinely orphaned and belongs to the
      // sweep, not here.
      const leg = this.heldRoute.get(item.symbol);
      if (!leg) continue;

      if (this.ship.nav.waypointSymbol !== leg.sellAt) {
        await this.navigateTo(leg.sellAt);
        // Reached only on the blocking path; under the scheduler navigateTo()
        // has already ended the tick and the next one re-enters above.
        return true;
      }

      await this.ensureDocked();
      const live = await this.liveSellPrice(leg.sellAt, item.symbol);
      if (live !== undefined && (await this.exceedsLossFloor(item.symbol, live))) {
        this.recordDoctrineFire?.("maxLossPct");
        this.log(`holding ${item.units}u ${item.symbol}: live sell ${live}c is below loss floor (cost ${this.heldCost.get(item.symbol)}c)`);
        return true;
      }

      this.currentStep = { kind: "transacting", action: "sell", good: item.symbol };
      this.assertAt(leg.sellAt, `sell ${item.symbol}`);
      const sold = await this.api.sellCargo(this.symbol, item.symbol, item.units);
      this.currentStep = IDLE_STEP;
      this.ship = { ...this.ship, cargo: sold.cargo };
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "SELL",
        tradeSymbol: item.symbol,
        units: item.units,
        pricePerUnit: sold.transaction.pricePerUnit,
        total: sold.transaction.totalPrice,
      });
      // The buy happened on an earlier tick, so the cost basis comes from
      // heldCost rather than a purchase response in scope. Signed, because a
      // loss rendered as "(+-9036c)" is what hid a losing loop for hours.
      const paid = (this.heldCost.get(item.symbol) ?? 0) * item.units;
      const delta = sold.transaction.totalPrice - paid;
      this.log(`sold ${item.units}u ${item.symbol} @ ${sold.transaction.pricePerUnit}c at ${leg.sellAt} (${delta >= 0 ? "+" : ""}${delta}c)`);
      this.onActivity?.("sell", `${item.units}u ${item.symbol} @ ${sold.transaction.pricePerUnit}c at ${leg.sellAt}`, sold.transaction.totalPrice, this.symbol);
      this.heldRoute.delete(item.symbol);
      return true;
    }
    return undefined;
  }

  private async runArbitrage(assigned: TraderAssignment | undefined): Promise<boolean> {
    // A trip already under way is the whole job this tick. Only once the hold
    // is clear does this ship look for new work.
    const delivering = await this.deliverHeldCargo();
    if (delivering !== undefined) return delivering;

    // Try routes in order of profitability, skipping any the live buy-price
    // guard rejects, until one actually buys. A single pass: no recursion.
    for (;;) {
      const route = this.findRoute();
      if (!route) break;
      if (this.ship.nav.waypointSymbol !== route.buyAt) {
        await this.navigateTo(route.buyAt);
        return true;
      }
      await this.ensureDocked();
      // Re-verify the live buy price before committing. The snapshot that drove
      // the route may be stale; if the price has inflated past the expected sell
      // price, buying now would lock in a loss. Refuse and let the next tick
      // re-evaluate (or pick a different route) instead of buying on a bad basis.
      const liveBuy = await this.liveBuyPrice(route.buyAt, route.good);
      if (liveBuy !== undefined && liveBuy > route.buyPrice) {
        const liveMargin = route.sellPrice - liveBuy;
        if (liveMargin < this.marginFloor) {
          this.recordDoctrineFire?.("marginFloor");
          this.log(
            `skipping buy: ${route.good} at ${route.buyAt} is now ${liveBuy}c (snapshot ${route.buyPrice}c), margin ${liveMargin}c below floor ${this.marginFloor}c`
          );
          // Remember this dead route so findRoute stops proposing it, then try
          // the next best route instead of retrying the same one every tick.
          this.deadRoutes.add(`${route.good}@${route.buyAt}`);
          continue;
        }
      }
      // Size the purchase against live credit, not the cached fleet balance the
      // route was planned under. The fleet refreshes credits only once per tick,
      // so after buying a new ship the cached figure is stale and this ship would
      // otherwise over-commit and fail the purchase (observed: trying to buy 58
      // FOOD with far fewer credits in hand).
      const liveCredits = await this.spendableNow();
      const buyPrice = liveBuy ?? route.buyPrice;
      const affordable = buyPrice > 0 ? Math.floor(liveCredits / buyPrice) : 0;
      let units = Math.min(route.volume, this.ship.cargo.capacity - this.ship.cargo.units, affordable);
      if (units <= 0) return true;
      // Also guard against over-filling the hold with a single oversized buy.
      units = Math.max(0, Math.floor(units));
      this.currentStep = { kind: "transacting", action: "buy", good: route.good };
      this.assertAt(route.buyAt, `buy ${route.good}`);
      const res = await this.api.purchaseCargo(this.symbol, route.good, units);
      this.currentStep = IDLE_STEP;
      this.ship = { ...this.ship, cargo: res.cargo };
      this.heldCost.set(route.good, res.transaction.pricePerUnit);
      this.heldRoute.set(route.good, { good: route.good, buyAt: route.buyAt, sellAt: route.sellAt, buyPrice: route.buyPrice, sellPrice: route.sellPrice });
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "PURCHASE",
        tradeSymbol: route.good,
        units,
        pricePerUnit: res.transaction.pricePerUnit,
        total: res.transaction.totalPrice,
      });
      this.log(`bought ${units}u ${route.good} @ ${res.transaction.pricePerUnit}c at ${route.buyAt}`);
      this.onActivity?.("buy", `${units}u ${route.good} @ ${res.transaction.pricePerUnit}c at ${route.buyAt}`, -res.transaction.totalPrice, this.symbol);
      // Stop here. The sell is a separate reconciled step — deliverHeldCargo()
      // picks the trip up next tick from the pin just recorded, and gets to
      // the market by arriving there rather than by falling through a
      // navigate whose failure the statements below could not see.
      return true;
    }

    // Prefer the assigned route's own buy/sell markets (that's where the
    // dispatcher wants us) for the price-discovery fallback.
    const direct = this.asDirectLeg(assigned);
    return this.discoverPrices(direct ? [direct.buyAt, direct.sellAt] : []);
  }

  /**
   * role = "buy": buy at `assigned.buyAt`, carry it to the warehouse ship's
   * waypoint, and hand it over with a real `transferCargo`. Falls back to
   * direct arbitrage when there's no warehouse ship to rendezvous with, or
   * the assignment isn't otherwise flyable — see docs/warehousing-plan.md §9.
   */
  private async runBuy(assigned: TraderAssignment): Promise<boolean> {
    const warehouse = this.getWarehouseShip?.();
    const buyAt = assigned.buyAt;
    if (!warehouse || !buyAt) return this.runArbitrage(undefined);
    // A missionBuy assignment exists specifically to acquire a
    // protectedGoods-listed good on the mission's behalf — the block is
    // there to stop ORDINARY trading from competing for a reserved good,
    // not to stop the mission from sourcing its own material this way.
    if (!assigned.missionBuy && this.protectedGoods?.().has(assigned.good)) return this.runArbitrage(undefined);
    if (this.deadRoutes.has(`${assigned.good}@${buyAt}`)) return this.runArbitrage(undefined);
    // Cross-system is allowed once the gate to buyAt's system is complete —
    // see systemsConnected()'s own comment.
    if (!this.systemsConnected(this.systemOf(warehouse.waypointSymbol), this.systemOf(buyAt))) return this.runArbitrage(undefined);

    await this.navigateTo(buyAt);
    await this.ensureDocked();

    const cached = this.priceTable.get(buyAt)?.get(assigned.good);
    const liveBuy = await this.liveBuyPrice(buyAt, assigned.good);
    const buyPrice = liveBuy ?? cached?.buy;
    if (buyPrice === undefined || buyPrice <= 0) return this.discoverPrices([buyAt]);
    if (assigned.buyPrice !== undefined && buyPrice > assigned.buyPrice) {
      this.log(`skipping buy: ${assigned.good} at ${buyAt} is now ${buyPrice}c (snapshot ${assigned.buyPrice}c)`);
      this.deadRoutes.add(`${assigned.good}@${buyAt}`);
      return this.discoverPrices([buyAt]);
    }

    const liveCredits = await this.spendableNow();
    const affordable = buyPrice > 0 ? Math.floor(liveCredits / buyPrice) : 0;
    const volume = cached?.volume ?? affordable;
    let units = Math.min(volume, this.ship.cargo.capacity - this.ship.cargo.units, affordable);
    units = Math.max(0, Math.floor(units));
    if (units <= 0) return this.discoverPrices([buyAt]);

    this.currentStep = { kind: "transacting", action: "buy", good: assigned.good };
    this.assertAt(buyAt, `buy ${assigned.good}`);
    const res = await this.api.purchaseCargo(this.symbol, assigned.good, units);
    this.currentStep = IDLE_STEP;
    this.ship = { ...this.ship, cargo: res.cargo };
    // Warehouse-bound cargo needs a cost basis too. Without this, a deposit
    // that failed its rendezvous left the goods in the hold with no basis, so
    // the leftover sweeper cleared them at any price the market offered.
    this.heldCost.set(assigned.good, res.transaction.pricePerUnit);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: assigned.good,
      units,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.log(`bought ${units}u ${assigned.good} @ ${res.transaction.pricePerUnit}c at ${buyAt}`);
    this.onActivity?.("buy", `${units}u ${assigned.good} @ ${res.transaction.pricePerUnit}c at ${buyAt}`, -res.transaction.totalPrice, this.symbol);

    await this.navigateTo(warehouse.waypointSymbol);
    await this.ensureDocked();
    try {
      const xfer = await this.api.transferCargo(this.symbol, assigned.good, units, warehouse.shipSymbol);
      this.ship = { ...this.ship, cargo: xfer.cargo };
      await this.warehouseDeposit?.(assigned.good, units, res.transaction.pricePerUnit, this.symbol);
      this.log(`deposited ${units}u ${assigned.good} into warehouse ship ${warehouse.shipSymbol}`);
      this.onActivity?.("warehouse-deposit", `${units}u ${assigned.good} into ${warehouse.shipSymbol}`, undefined, this.symbol);
    } catch (err) {
      // Rendezvous failed this tick (warehouse ship not there yet, etc). The
      // cargo stays in the hold; clearLeftoverCargo sweeps it to market next
      // tick if the deposit keeps failing, rather than stranding it forever.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`deposit into warehouse ship failed: ${msg}`);
    }
    return true;
  }

  /**
   * role = "sell": withdraw from the warehouse ship with a real
   * `transferCargo`, carry it to `assigned.sellAt`, and sell. Falls back to
   * direct arbitrage under the same conditions as runBuy.
   */
  private async runSell(assigned: TraderAssignment): Promise<boolean> {
    const warehouse = this.getWarehouseShip?.();
    const sellAt = assigned.sellAt;
    if (!warehouse || !sellAt) return this.runArbitrage(undefined);
    if (this.protectedGoods?.().has(assigned.good)) return this.runArbitrage(undefined);
    // Cross-system is allowed once the gate to sellAt's system is complete —
    // see systemsConnected()'s own comment.
    if (!this.systemsConnected(this.systemOf(warehouse.waypointSymbol), this.systemOf(sellAt))) return this.runArbitrage(undefined);

    const balance = (await this.warehouseBalance?.(assigned.good)) ?? 0;
    if (balance <= 0) return this.discoverPrices([sellAt]);

    await this.navigateTo(warehouse.waypointSymbol);
    await this.ensureDocked();

    const room = this.ship.cargo.capacity - this.ship.cargo.units;
    const units = Math.max(0, Math.floor(Math.min(balance, room)));
    if (units <= 0) return this.discoverPrices([sellAt]);

    let withdrawn: { units: number; avgCost: number };
    try {
      // The warehouse ship is the sender here, so this call is made as the
      // warehouse ship, not this trader — transferCargo is parameterized by
      // ship symbol, not by who's "logged in".
      await this.api.transferCargo(warehouse.shipSymbol, assigned.good, units, this.symbol);
      // The response carries the SENDER's (warehouse ship's) cargo, not
      // ours — refresh to pick up what we actually received.
      await this.refresh();
      withdrawn = (await this.warehouseWithdraw?.(assigned.good, units, this.symbol)) ?? { units, avgCost: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`withdraw from warehouse ship failed: ${msg}`);
      return false;
    }
    if (withdrawn.units <= 0) return false;
    this.heldCost.set(assigned.good, withdrawn.avgCost);
    this.log(`withdrew ${withdrawn.units}u ${assigned.good} from warehouse ship ${warehouse.shipSymbol} (cost basis ${withdrawn.avgCost}c)`);
    this.onActivity?.("warehouse-withdraw", `${withdrawn.units}u ${assigned.good} from ${warehouse.shipSymbol}`, undefined, this.symbol);

    await this.navigateTo(sellAt);
    await this.ensureDocked();
    const live = await this.liveSellPrice(sellAt, assigned.good);
    if (live !== undefined && await this.exceedsLossFloor(assigned.good, live)) {
      this.recordDoctrineFire?.("maxLossPct");
      this.log(`holding ${withdrawn.units}u ${assigned.good}: live sell ${live}c is below loss floor (cost ${withdrawn.avgCost}c)`);
      return true;
    }
    const minMargin = this.warehouseMinMargin?.() ?? 0;
    if (live !== undefined && live - withdrawn.avgCost < minMargin) {
      this.log(`holding ${withdrawn.units}u ${assigned.good}: live sell ${live}c clears cost basis (${withdrawn.avgCost}c) by only ${live - withdrawn.avgCost}c, below warehouse margin floor ${minMargin}c`);
      return true;
    }
    this.currentStep = { kind: "transacting", action: "sell", good: assigned.good };
    this.assertAt(sellAt, `sell ${assigned.good}`);
    const sold = await this.api.sellCargo(this.symbol, assigned.good, withdrawn.units);
    this.currentStep = IDLE_STEP;
    this.ship = { ...this.ship, cargo: sold.cargo };
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "SELL",
      tradeSymbol: assigned.good,
      units: withdrawn.units,
      pricePerUnit: sold.transaction.pricePerUnit,
      total: sold.transaction.totalPrice,
    });
    this.log(`sold ${withdrawn.units}u ${assigned.good} @ ${sold.transaction.pricePerUnit}c at ${sellAt}`);
    this.onActivity?.("sell", `${withdrawn.units}u ${assigned.good} @ ${sold.transaction.pricePerUnit}c at ${sellAt}`, sold.transaction.totalPrice, this.symbol);
    return true;
  }

  /**
   * role = "haul": withdraw from the warehouse ship — same rendezvous as
   * runSell — and deliver to a mission's construction site instead of a
   * market. `assigned.sellAt` carries the construction waypoint (dispatcher's
   * toHaulAssignment repurposes the field rather than adding a haul-only
   * one). No loss-floor/margin gate: this isn't a sale, it's fulfilling a
   * requirement, so whatever's withdrawn gets delivered.
   */
  private async runHaul(assigned: TraderAssignment): Promise<boolean> {
    const warehouse = this.getWarehouseShip?.();
    const targetWaypoint = assigned.sellAt;
    if (!warehouse || !targetWaypoint) return this.runArbitrage(undefined);
    // Cross-system is allowed once the gate to targetWaypoint's system is
    // complete — see systemsConnected()'s own comment.
    if (!this.systemsConnected(this.systemOf(warehouse.waypointSymbol), this.systemOf(targetWaypoint))) return this.runArbitrage(undefined);

    const balance = (await this.warehouseBalance?.(assigned.good)) ?? 0;
    if (balance <= 0) return this.discoverPrices([]);

    await this.navigateTo(warehouse.waypointSymbol);
    await this.ensureDocked();

    const room = this.ship.cargo.capacity - this.ship.cargo.units;
    const units = Math.max(0, Math.floor(Math.min(balance, room)));
    if (units <= 0) return this.discoverPrices([]);

    let withdrawn: { units: number; avgCost: number };
    try {
      // Same as runSell: made as the warehouse ship, since it's the sender.
      await this.api.transferCargo(warehouse.shipSymbol, assigned.good, units, this.symbol);
      await this.refresh();
      withdrawn = (await this.warehouseWithdraw?.(assigned.good, units, this.symbol)) ?? { units, avgCost: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`withdraw from warehouse ship failed: ${msg}`);
      return false;
    }
    if (withdrawn.units <= 0) return false;
    this.log(`withdrew ${withdrawn.units}u ${assigned.good} from warehouse ship ${warehouse.shipSymbol} for haul to ${targetWaypoint}`);
    this.onActivity?.("warehouse-withdraw", `${withdrawn.units}u ${assigned.good} from ${warehouse.shipSymbol} (haul)`, undefined, this.symbol);

    await this.navigateTo(targetWaypoint);
    await this.ensureDocked();
    try {
      this.assertAt(targetWaypoint, `supply ${assigned.good}`);
      const res = await this.api.supplyConstruction(this.systemOf(targetWaypoint), targetWaypoint, this.symbol, assigned.good, withdrawn.units);
      this.ship = { ...this.ship, cargo: res.cargo };
      this.log(`hauled ${withdrawn.units}u ${assigned.good} to ${targetWaypoint}`);
      this.onActivity?.("haul", `${withdrawn.units}u ${assigned.good} to ${targetWaypoint}`, undefined, this.symbol);
    } catch (err) {
      // Delivery failed this tick (mission already complete, site unreachable,
      // etc). The cargo stays in the hold; clearLeftoverCargo sweeps it to
      // market next tick if it keeps failing, rather than stranding it.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`supply to ${targetWaypoint} failed: ${msg}`);
    }
    return true;
  }

  /**
   * role = "contractBuy": buy `assigned.good` at `assigned.buyAt` and just
   * hold it — no warehouse leg, no sell leg. The deliverCargo check at the
   * top of tick() picks it up on a later tick once it's in the hold and
   * routes/delivers it to whichever contract needs it. Deliberately does
   * NOT check protectedGoods (unlike runBuy/runSell) — the whole point of
   * this role is to acquire a good protectedGoods would otherwise block.
   */
  private async runContractBuy(assigned: TraderAssignment): Promise<boolean> {
    const buyAt = assigned.buyAt;
    if (!buyAt) return this.runArbitrage(undefined);
    if (this.deadRoutes.has(`${assigned.good}@${buyAt}`)) return this.runArbitrage(undefined);

    await this.navigateTo(buyAt);
    await this.ensureDocked();

    const cached = this.priceTable.get(buyAt)?.get(assigned.good);
    const liveBuy = await this.liveBuyPrice(buyAt, assigned.good);
    const buyPrice = liveBuy ?? assigned.buyPrice;
    if (buyPrice === undefined || buyPrice <= 0) {
      // Genuinely no price to buy at — touring to find one is the right
      // answer here, unlike the exits below. Say so anyway: every exit from
      // this function used to be silent, which is how a trader spent an hour
      // shuttling between two waypoints while the fleet line called it idle.
      this.log(`contract buy for ${assigned.good}: no price known at ${buyAt}, touring to find one`);
      return this.discoverPrices([buyAt]);
    }
    if (assigned.buyPrice !== undefined && buyPrice > assigned.buyPrice * 1.5) {
      // A contract still needs this good regardless of price, so this isn't
      // a hard refusal the way runBuy's margin check is — just avoid
      // overpaying wildly on a stale snapshot. Try again once the dispatcher
      // recomputes with fresher intel.
      this.log(`skipping contract buy: ${assigned.good} at ${buyAt} is now ${buyPrice}c (snapshot ${assigned.buyPrice}c)`);
      this.deadRoutes.add(`${assigned.good}@${buyAt}`);
      return this.discoverPrices([buyAt]);
    }

    const liveCredits = await this.spendableNow();
    const affordable = buyPrice > 0 ? Math.floor(liveCredits / buyPrice) : 0;
    // Confirmed live: without the tradeVolume cap this tried to buy the
    // ship's full cargo space (or however much was affordable) in one
    // transaction — "SILVER has a limit of 60 units per transaction" on
    // every retry, forever, since the request itself never changed. Same
    // per-transaction cap runBuy() already respects (line ~1025 above).
    const volume = cached?.volume ?? affordable;
    const holdRoom = this.ship.cargo.capacity - this.ship.cargo.units;
    let cap = Math.min(volume, holdRoom, affordable);
    // Kept as its own variable rather than re-derived from `cap` below: once
    // three limits have been min()'d together, a zero no longer says which
    // one produced it, and the whole point of the exits below is to name the
    // reason correctly.
    let stillNeeded = Infinity;
    if (this.contractNeeded) {
      // Confirmed live: with only the tradeVolume/cargo/affordability caps
      // above, a ship topping off the last few outstanding units of a
      // contract (3 of 63, say) bought a full market-limit lot (60) anyway —
      // the request had no idea how much was actually still wanted. It
      // delivered what the contract needed and was left holding the rest
      // with no role for it, falling through to clearLeftoverCargo() to sell
      // at a loss against the contract's own buy price.
      const alreadyHeld = this.ship.cargo.inventory.find((i) => i.symbol === assigned.good)?.units ?? 0;
      stillNeeded = Math.max(0, (await this.contractNeeded(assigned.good)) - alreadyHeld);
      cap = Math.min(cap, stillNeeded);
    }
    const units = Math.max(0, Math.floor(cap));
    if (units <= 0) {
      // Nothing bought, and the reason decides what to do instead — this is
      // where the hour of shuttling came from. The old code returned
      // discoverPrices() for every one of these, which tours markets and
      // reports success, so the ship looked busy, the dispatcher kept the
      // assignment, and nothing anywhere said why no purchase ever happened.
      //
      // Only the price-discovery case is worth touring for. The others are
      // states touring cannot change: a contract that needs nothing more, a
      // hold with no room, or — the live case — a balance too small to buy a
      // single unit of a good a contract pays 181,474c for. A ship that
      // cannot afford its assignment should go and earn, not orbit.
      if (stillNeeded <= 0) {
        this.log(`contract buy for ${assigned.good}: contract needs no more units; trading instead`);
        return this.runArbitrage(undefined);
      }
      if (affordable <= 0) {
        this.log(
          `contract buy for ${assigned.good}: cannot afford one unit at ${buyPrice}c with ${liveCredits}c in hand; trading instead`,
        );
        return this.runArbitrage(undefined);
      }
      if (holdRoom <= 0) {
        this.log(`contract buy for ${assigned.good}: hold is full, cannot take any on`);
        return false;
      }
      this.log(`contract buy for ${assigned.good}: no units to buy at ${buyAt} (volume ${volume}, affordable ${affordable})`);
      return this.discoverPrices([buyAt]);
    }

    this.currentStep = { kind: "transacting", action: "buy", good: assigned.good };
    this.assertAt(buyAt, `buy ${assigned.good}`);
    const res = await this.api.purchaseCargo(this.symbol, assigned.good, units);
    this.currentStep = IDLE_STEP;
    this.ship = { ...this.ship, cargo: res.cargo };
    this.heldCost.set(assigned.good, res.transaction.pricePerUnit);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: assigned.good,
      units,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.log(`bought ${units}u ${assigned.good} @ ${res.transaction.pricePerUnit}c at ${buyAt} for contract delivery`);
    this.onActivity?.("buy", `${units}u ${assigned.good} @ ${res.transaction.pricePerUnit}c at ${buyAt} (contract)`, -res.transaction.totalPrice, this.symbol);
    return true;
  }

  /** One trade cycle: ensure prices → dispatch on role → act. */
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
    // The only other place this clears is a completed fuel-tender rescue
    // (fleet.ts) — so a ship that recovers any other way (an operator's
    // manual Refuel, docking somewhere it could top off, or the original
    // error simply not having been about navigation fuel at all — see
    // nextTask()'s /fuel/i match, which catches things like "Trade good
    // FUEL is not available at X" too) kept showing as stranded on the
    // dashboard forever, with no tender ever coming to "fix" it because
    // there was nothing left to fix. Real fuel is the ground truth here,
    // not the flag.
    if (this.stranded && this.ship.fuel.current > 0) this.clearStranded();
    // If manually dispatched, hold at the target until released.
    if (this.manualWaypoint) {
      if (this.ship.nav.waypointSymbol !== this.manualWaypoint || this.ship.nav.status === "IN_TRANSIT") {
        await this.navigateTo(this.manualWaypoint);
        await this.ensureDocked();
      }
      return false;
    }
    await this.loadSnapshots();
    const assignedAtTickStart = this.assignedRoute?.();
    // Dead routes are per-tick: a market's price can recover, so forget them
    // once we've had a chance to pick a different route.
    //
    // Reachability is not a price, though. A system with no gate to it does
    // not become reachable because two seconds passed, and clearing those
    // here made markRouteUnreachable() a no-op with a lifetime of one tick —
    // it was added to stop an unreachable leg being retried forever and could
    // not do that. Keep them separately and permanently: the only thing that
    // changes reachability is the galaxy itself, and a newly completed gate
    // arrives through GalaxyAtlas.canJump(), which viableRoute() consults
    // before deadRoutes is ever reached.
    this.deadRoutes.clear();
    for (const key of this.unreachableRoutes) this.deadRoutes.add(key);

    // Contract delivery outranks everything else, same as ShipAgent's own
    // tick() — a trader holding a contract-deliverable good (from a
    // "contractBuy" assignment, a warehouse withdrawal, a manual transfer)
    // routes/delivers it before clearLeftoverCargo() or any route work ever
    // gets a chance to sell it.
    if (this.ship.cargo.units > 0 && this.deliverCargo) {
      const result = await this.deliverCargo(this.ship);
      if (typeof result === "string") {
        // Confirmed live: deliverVia() picks the contract's destination for
        // *any* ship carrying a matching good, with no distance check at all
        // — unlike viableRoute()'s ordinary route candidates, which reject a
        // leg the tank can never cover regardless of fuel level (see that
        // guard's own comment for the same "full tank, still fails" failure
        // signature). A ship whose own arbitrage trade happened to pick up a
        // good a contract also wants got yanked toward a destination outside
        // its single-hop range, threw a raw "requires N more fuel" error,
        // and got mislabeled stranded below even at full tank. Apply the
        // same guard here — but route through an intermediate fuel stop
        // instead of just giving up: confirmed live, a ship that bought
        // contract cargo out of its own single-hop range from the delivery
        // destination sat holding it forever, re-hitting this same skip
        // every tick, since nothing here ever tried a multi-hop route (the
        // way mission cargo delivery already does via fleet.ts's
        // dispatchShipHop). nextHopToward() returning undefined means no
        // known fuel stop gets any closer — a route that really can't work,
        // not just one not tried yet.
        if (this.ship.fuel.capacity > 0 && this.distBetween(this.ship.nav.waypointSymbol, result) > this.ship.fuel.capacity) {
          const hop = this.nextHopToward(result);
          if (!hop) {
            this.log(`contract delivery to ${result} is out of range even via known fuel stops; skipping for now`);
          } else {
            this.log(`delivering cargo → ${result} via ${hop} (single hop can't reach it directly)`);
            await this.navigateTo(hop);
            await this.refresh();
            return true;
          }
        } else {
          // navigateTo() self-manages refueling (see its own comment) — no
          // separate pre-check needed, unlike ShipAgent's refuelIfNeeded()
          // gate.
          this.log(`delivering cargo → ${result}`);
          await this.navigateTo(result);
          await this.ensureDocked();
          await this.deliverCargo(this.ship);
          await this.refresh();
          return true;
        }
      } else if (result === true) {
        await this.refresh();
        return true;
      }
    }

    const leftoverResult = await this.clearLeftoverCargo();
    if (leftoverResult !== undefined) return leftoverResult;

    if (assignedAtTickStart?.role === "buy") return this.runBuy(assignedAtTickStart);
    if (assignedAtTickStart?.role === "sell") return this.runSell(assignedAtTickStart);
    if (assignedAtTickStart?.role === "haul") return this.runHaul(assignedAtTickStart);
    if (assignedAtTickStart?.role === "contractBuy") return this.runContractBuy(assignedAtTickStart);
    return this.runArbitrage(assignedAtTickStart);
  }

  /** True when the fleet is halted and this ship must not act. Stopgap until
   *  the greenfield scheduler enforces pause at dispatch (pillar 3). */
  private halted(): boolean {
    return this.shouldRun !== undefined && !this.shouldRun();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Shared by runLoop()'s catch and nextTask()'s (the scheduler-driven path
   * that's actually live in production, since fleet.ts runs ships through
   * the scheduler, not runLoop()) — kept as one method after the two copies
   * were found to have silently drifted: nextTask()'s still had the old
   * blanket check after runLoop()'s was fixed. Any error whose message
   * merely contains "fuel" used to mark the ship stranded — but "Navigate
   * request failed: requires N more fuel" fires just as readily on a full
   * tank attempting a leg that's simply outside its single-hop range
   * (confirmed live: a 400/400 ship hit this) as it does on a ship that's
   * genuinely near-empty with nowhere reachable. The tender-rescue system
   * this flag drives is for the latter only — sending a tender to a
   * full-tank ship wastes the trip and, worse, used to send that same ship
   * right back at the identical unreachable leg next tick, re-triggering
   * this forever. Low current fuel is the actual signal "stranded" is
   * supposed to mean.
   */
  private handleTickError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.log(`trader error: ${msg}`);
    if (/fuel/i.test(msg) && this.ship.fuel.current <= this.ship.fuel.capacity * 0.1) this.markStranded();
  }

  /**
   * Greenfield Phase 6: this trader as a Scheduler `Task` producer, wrapping
   * the exact same `tick()` `runLoop()` already calls — no trading logic is
   * duplicated or reimplemented, just its control flow re-shaped from
   * "block and sleep" to "return one Task, chain the next." Mirrors
   * `runLoop()`'s own backoff rules exactly: halted polls again after
   * `HALT_POLL_MS`, a tick that did nothing backs off 30s (same as
   * `!made`), an error backs off 10s and still marks the ship stranded on a
   * fuel error — so a scheduler driving this instead of `runLoop()` would
   * observe identical timing, not just identical trades.
   *
   * `estimatedCalls: 3` is a fixed heuristic (one navigate + one buy/sell +
   * one refresh, roughly), not a real per-route estimate — the scheduler
   * needs *some* number before the work runs, to decide whether to admit
   * this task at all, so a pre-run guess is unavoidable here regardless.
   * `actualCalls`, though, is measured for real: `Client.getCallCount()`'s
   * delta across the actual `tick()` call, not another guess — see
   * README's Greenfield section.
   */
  nextTask(earliestRunAt = Date.now()): Task {
    // Confirmed live: this used to unconditionally set this.running = true
    // here, on the theory that a caller could never forget to flip it before
    // scheduling. But this method is also called internally, from within its
    // own run()'s `next: this.nextTask(...)` chaining — a stop() landing
    // while a task is mid-flight (tick() can take many seconds) got silently
    // undone the moment that in-flight call finished and chained its own
    // next task, resurrecting a supposedly-stopped agent into an immortal
    // loop running in parallel with whatever replaced it. Every external
    // enqueue site (fleet.ts's setShipRole()/syncSchedulerTasks()) already
    // sets this.running = true itself immediately before the first call, so
    // this doesn't need to and must not do it again on every chain step.
    return {
      id: `${this.symbol}-trade`,
      shipSymbol: this.symbol,
      priority: 2,
      estimatedCalls: 3,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        // Cutover: a stopped agent (scrapped, or converted to another role —
        // see fleet.ts's removeShip()/maybeAssignKeepers()) must not keep
        // chaining a task forever just because its last `next` was already
        // enqueued. No `next` here ends the chain for good — the same way
        // `runLoop()`'s own `while (this.running)` would have exited.
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) {
          return { actualCalls: 0, next: this.nextTask(Date.now() + HALT_POLL_MS) };
        }
        // Real measured count (Client.getCallCount() delta), not the fixed
        // `estimatedCalls: 3` heuristic above — the estimate is still a
        // guess made before the work runs (needed for the scheduler's
        // pre-admission budget check), but what actually happened is now
        // truth, not another guess.
        const before = this.api.getCallCount();
        // Only true for the duration of this call — see agentStep.ts's
        // NavigationPending doc comment and the schedulerDriven field's own
        // comment for why this can't just be set once and left true.
        this.schedulerDriven = true;
        // Confirmed live: suspend()'s whole reason to await `inFlight` is to
        // let a caller (a mission, a rescue tender) safely mutate this ship's
        // nav state right after — but `inFlight` was only ever set inside
        // runLoop(), which is dead in production (fleet.ts drives every ship
        // through the scheduler, i.e. this method, not runLoop()). So
        // suspend() never actually waited for anything: it could return while
        // this tick() call was still mid-flight, and the caller's own direct
        // API calls would race it — exactly the "stale cached ship state"
        // scenario suspend()'s own doc comment warns about. Setting it here
        // is the scheduler-path equivalent of what runLoop() already does.
        const p = this.tick();
        this.inFlight = p;
        try {
          const made = await p;
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof Pending) {
            // Not a real error: tick() just started a transit. Resume at the
            // real arrival time instead of blocking this Task.run() call for
            // the rest of it — see docs/eta-scheduled-ship-waits.md.
            return { actualCalls, next: this.nextTask(err.resumeAt) };
          }
          this.handleTickError(err);
          return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }

  /** True when the ship can't reach any market (low fuel) and needs a tender. */
  isStranded(): boolean {
    return this.stranded;
  }

  /** Mark the ship stranded so the fleet's fuel-tender rescue can find it. */
  markStranded(): void {
    this.stranded = true;
    this.log("marked stranded (insufficient fuel to reach a market)");
  }

  /** Clear the stranded flag once the ship can move again. */
  clearStranded(): void {
    this.stranded = false;
  }
}
