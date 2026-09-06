import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { WaypointPos } from "./agent.js";
import type { MarketSnapshot } from "./market.js";
import type { Task, TaskResult } from "./scheduler.js";
import { type AgentStep, IDLE_STEP, Pending } from "./agentStep.js";
import { Registry } from "./registry.js";
import { standDownReason } from "./intent.js";
import { ShipProxy } from "./shipProxy.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

export interface SiphonerOptions {
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
  /** Called for notable events (siphon, sell, refuel, navigate) for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Whether a waypoint carries the MARKETPLACE trait, from the galaxy atlas.
   *  `markets` only lists waypoints already snapshotted and is never refreshed
   *  after construction, so a ship can sit on a fuel station it does not know
   *  is one. */
  /** Trade symbols reserved for missions; these must never be sold/jettisoned. */
  protectedGoods?: () => Set<string>;
  /** Whether the ship may act right now. False while the fleet is halted. */
  /**
   * This ship's committed intent, read live from the fleet's board. An agent
   * stands down rather than acting when the fleet itself is driving the hull
   * — see intent.ts's drivenByFleet(). Optional, so an agent built without a
   * board (a test, a bare CLI run) behaves exactly as before.
   */
  intentFor?: () => import("./intent.js").ShipIntent | undefined;
  shouldRun?: () => boolean;
}


/**
 * Gas siphoner: flies between gas giants and the best-paying gas market.
 * Extracts gas with a MOUNT_GAS_SIPHON until the hold is full, then docks,
 * sells and refuels. Small hold (a siphon drone fits ~40 units), so the loop
 * is short and the sell decision is driven by live market snapshots.
 */
export class SiphonerAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: SiphonerOptions["recordLedger"];
  private readonly onActivity: SiphonerOptions["onActivity"];
  private readonly recordMarket: SiphonerOptions["recordMarket"];
  private readonly protectedGoods?: () => Set<string>;
  /** The world, held by reference — see registry.ts and scout.ts's identical field. */
  private registry: Registry = Registry.standalone();
  private readonly intentFor?: SiphonerOptions["intentFor"];
  private readonly shouldRun?: () => boolean;
  private readonly proxy: ShipProxy;
  /** Every `this.ship` read and write goes through the one copy the proxy
   *  owns — see shipProxy.ts. */
  private get ship(): Ship { return this.proxy.getShip(); }
  private set ship(s: Ship) { this.proxy.setShip(s); }
  private suspended = false;
  /** The currently in-flight tick(), if any — suspend() awaits this so a caller
   *  about to mutate this ship's nav state directly (rescue/mission dispatch)
   *  can't race a tick that's already mid-flight against stale cached state. */
  private inFlight: Promise<unknown> | null = null;
  /** Manual override: park at this waypoint and hold until released. */
  private manualGoal: string | null = null;
  running = false;
  private get currentStep(): AgentStep { return this.proxy.getStep(); }
  private set currentStep(s: AgentStep) { this.proxy.setStep(s); }
  /** True only for the exact duration of nextTask()'s run() closure's call
   *  into tick() — see agentStep.ts's NavigationPending doc comment for why
   *  this is scoped this narrowly rather than a flag set once and left true:
   *  dispatchTo()-style manual dispatch also reaches navigateTo(), never
   *  through tick(), and must keep blocking exactly as before. */
  private get schedulerDriven(): boolean { return this.proxy.schedulerDriven; }
  private set schedulerDriven(v: boolean) { this.proxy.schedulerDriven = v; }

  /** What this ship is doing right now, if it's mid-navigation or mid-transaction — see agentStep.ts. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: SiphonerOptions) {
    this.symbol = ship.symbol;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.intentFor = opts.intentFor;
    this.shouldRun = opts.shouldRun;
    this.protectedGoods = opts.protectedGoods;
    // Built last: it owns the ship state the `this.ship` accessor reads
    // through, so nothing may touch that accessor before this line.
    this.proxy = new ShipProxy(ship, {
      api: opts.api,
      registry: this.registry,
      log: this.log,
      onActivity: opts.onActivity,
      recordMarket: opts.recordMarket,
      recordLedger: opts.recordLedger,
    });
  }

  /** Read the world from the fleet's live registry instead of a private copy. */
  withRegistry(registry: Registry): this {
    this.registry = registry;
    this.proxy.setRegistry(registry);
    return this;
  }

  /** Seed positions and prices directly, for an agent with no shared registry. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[] = []): this {
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

  isManual(): boolean {
    return this.manualGoal !== null;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /** Awaits any tick already in flight before returning — see agent.ts's
   *  `suspend()` for why: without it, a caller that immediately mutates this
   *  ship's nav state directly via the raw API can race a tick that's already
   *  mid-flight against stale cached ship state. */
  async suspend(): Promise<void> {
    this.suspended = true;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  resume(): void {
    this.suspended = false;
  }

  /** Park at this waypoint and hold there until `release()` is called. */
  dispatchTo(waypoint: string): void {
    this.manualGoal = waypoint;
  }

  release(): void {
    this.manualGoal = null;
  }

  private async refresh(): Promise<void> {
    return this.proxy.refresh();
  }

  private async waitCooldown(): Promise<void> {
    return this.proxy.waitCooldown();
  }

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

  /** True if the ship can reach the target with its current fuel. Unknown positions count as unreachable. */
  private canReach(waypoint: string): boolean {
    if (this.ship.fuel.capacity <= 0) return true;
    return this.estimatedFuelTo(waypoint) <= this.ship.fuel.current;
  }

  private estimatedFuelTo(waypoint: string): number {
    return this.registry.fuelFor(this.ship.nav.waypointSymbol, waypoint);
  }

  private distanceTo(wp: WaypointPos): number {
    return this.registry.distance(this.ship.nav.waypointSymbol, wp.symbol);
  }

  private cargoFree(): number {
    return this.ship.cargo.capacity - this.ship.cargo.units;
  }

  /** Nearest gas giant that is reachable now, or reachable after a refuel at a market. */
  private pickGasGiant(): WaypointPos | undefined {
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of this.registry.waypointsIn(this.ship.nav.systemSymbol)) {
      if (wp.type !== "GAS_GIANT") continue;
      const dist = this.distanceTo(wp);
      if (dist >= bestDist) continue;
      if (this.ship.fuel.capacity > 0) {
        const out = this.estimatedFuelTo(wp.symbol);
        if (out > this.ship.fuel.current) {
          const refuelStop = this.nearestReachableMarket();
          if (!refuelStop) continue; // no way to refuel en route
          const toFuel = this.estimatedFuelToBetween(this.ship.nav.waypointSymbol, refuelStop);
          const fromFuel = this.estimatedFuelToBetween(refuelStop, wp.symbol);
          if (toFuel + fromFuel > this.ship.fuel.capacity) continue;
        }
      }
      bestDist = dist;
      best = wp;
    }
    return best;
  }

  private nearestReachableMarket(): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
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

  private estimatedFuelToBetween(a: string, b: string): number {
    return this.registry.fuelFor(a, b);
  }

  /** Best market for the cargo currently held: highest total sell value, reachable with current fuel. */
  private bestSellMarket(): { symbol: string; value: number } | undefined {
    const held = this.ship.cargo.inventory.filter((i) => i.units > 0 && !(this.protectedGoods?.() ?? new Set()).has(i.symbol));
    if (held.length === 0) return undefined;
    let best: { symbol: string; value: number } | undefined;
    for (const m of this.registry.markets(this.ship.nav.systemSymbol)) {
      if (this.ship.fuel.capacity > 0 && !this.canReach(m.symbol)) continue;
      let value = 0;
      for (const item of held) {
        const price = m.tradeGoods[item.symbol]?.sellPrice ?? 0;
        value += price * item.units;
      }
      if (!best || value > best.value) best = { symbol: m.symbol, value };
    }
    return best;
  }

  /**
   * Boolean-returning wrapper over the shared primitive: this class's callers
   * branch on success (`const ok = await this.navigateTo(x); if (!ok) return;`)
   * rather than catching. A Pending must still propagate — swallowing one into
   * `return false` is exactly the bug this file had before the shared
   * implementation existed.
   */
  private async navigateTo(waypoint: string): Promise<boolean> {
    try {
      await this.proxy.navigateTo(waypoint);
      return true;
    } catch (err) {
      if (err instanceof Pending) throw err;
      this.log(`navigate failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * The gas giant a siphon session is in progress at, or null — the same
   * idea as ShipAgent.miningSession: under the scheduler each siphon's
   * cooldown ends the tick, and the next tick must keep siphoning rather
   * than fly off to sell the handful of units already aboard.
   */
  private siphonSession: string | null = null;

  /** Siphon until the hold is full (or the loop safety cap trips). */
  private async siphonUntilFull(): Promise<boolean> {
    await this.ensureInOrbit();
    this.siphonSession = this.ship.nav.waypointSymbol;
    let safety = 0;
    while (this.cargoFree() > 0 && safety < 40) {
      safety += 1;
      try {
        this.currentStep = { kind: "transacting", action: "siphon" };
        const res = await this.api.siphon(this.symbol);
        this.currentStep = IDLE_STEP;
        this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
        const got = res.siphon.yield;
        this.onActivity?.("siphon", `+${got.units}u ${got.symbol} (${this.ship.cargo.units}/${this.ship.cargo.capacity})`, undefined, this.symbol);
        this.log(`siphoned ${got.units}u ${got.symbol}`);
        await this.waitCooldown();
      } catch (err) {
        if (err instanceof Pending) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/cooldown/i.test(msg)) {
          this.log(`siphon pending cooldown, waiting…`);
          await this.pause(6_000);
          continue;
        }
        this.log(`siphon failed: ${msg}`);
        this.siphonSession = null;
        return false;
      }
    }
    this.siphonSession = null;
    if (safety >= 40) this.log("siphon loop hit safety cap");
    return true;
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
        this.onActivity?.("sell", `${item.units}u ${item.symbol} @ ${res.transaction.pricePerUnit}c`, res.transaction.totalPrice, this.symbol);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`sell failed: ${msg}`);
      }
    }
  }

  /** Top up fuel whenever docked at a market; detour to the nearest reachable market when low. */
  private async refuelIfNeeded(): Promise<void> {
    // Tops up whenever at a pump and under half a tank; it never plans a
    // round trip, so it budgets by fraction rather than by leg.
    await this.proxy.refuelIfNeeded({ belowFraction: 0.5 });
  }

  async tick(): Promise<boolean> {
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

    // Manual override: fly to the pinned waypoint and park there for good.
    if (this.manualGoal) {
      if (this.ship.nav.waypointSymbol === this.manualGoal && this.ship.nav.status === "DOCKED") {
        this.log(`parked at ${this.manualGoal}, holding`);
        return false;
      }
      const ok = await this.navigateTo(this.manualGoal);
      if (ok) await this.ensureDocked();
      return true;
    }

    const held = this.ship.cargo.inventory.filter((i) => i.units > 0);
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const sellable = held.filter((i) => !protectedGoods.has(i.symbol));

    // A siphon session interrupted by its own cooldown resumes here with a
    // part-filled hold: keep siphoning rather than selling it — see siphonSession.
    if (this.siphonSession !== null && (this.siphonSession !== this.ship.nav.waypointSymbol || this.ship.nav.status === "IN_TRANSIT")) {
      this.siphonSession = null;
    }
    const midSiphon = this.siphonSession !== null && this.cargoFree() > 0;

    // 1. Sell first: the hold is small, so a full hold means idle income.
    if (!midSiphon && sellable.length > 0) {
      const target = this.bestSellMarket();
      if (target) {
        if (this.ship.nav.waypointSymbol !== target.symbol || this.ship.nav.status !== "DOCKED") {
          this.log(`selling ${sellable.length} cargo worth ~${target.value}c`);
          const ok = await this.navigateTo(target.symbol);
          if (!ok) return true;
          await this.ensureDocked();
        }
        await this.sellAllCargo();
        await this.refuelIfNeeded();
        await this.refresh();
        return true;
      }
      // No known buyer: tour markets, or just sit until prices appear.
      this.log("no reachable gas market snapshot; idling with cargo");
      return false;
    }

    // 2. Siphon at the gas giant we're parked at.
    if (this.registry.typeOf(this.ship.nav.waypointSymbol) === "GAS_GIANT") {
      return this.siphonUntilFull();
    }

    // 3. Otherwise fly to the nearest gas giant.
    const target = this.pickGasGiant();
    if (!target) {
      this.log("no gas giant in the atlas; idling");
      return false;
    }
    await this.refuelIfNeeded();
    await this.navigateTo(target.symbol);
    return true;
  }

  /** True when the fleet is halted and this ship must not act. Stopgap until
   *  the greenfield scheduler enforces pause at dispatch (pillar 3). */
  private halted(): boolean {
    return this.shouldRun !== undefined && !this.shouldRun();
  }

  stop(): void {
    this.running = false;
  }

  /** Scheduler Task producer wrapping tick(), same approach as TraderAgent.nextTask() — see that file's comment. Driven for real by fleet.run() when a Scheduler is wired in (see FleetManager.syncSchedulerTasks()). */
  nextTask(earliestRunAt = Date.now()): Task {
    // Deliberately not set here — see agent.ts's ShipAgent.nextTask() comment:
    // every external enqueue site sets this.running=true itself, and setting
    // it unconditionally here too would let a stop() landing mid-flight get
    // silently undone the moment the in-flight call chains its own next task.
    return {
      id: `${this.symbol}-siphon`,
      shipSymbol: this.symbol,
      priority: 2,
      estimatedCalls: 3,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        if (!this.running) return { actualCalls: 0 };
        if (this.halted()) return { actualCalls: 0, next: this.nextTask(Date.now() + HALT_POLL_MS) };
        const before = this.api.getCallCount();
        this.schedulerDriven = true;
        // See TraderAgent.nextTask()'s comment on inFlight.
        const p = this.tick();
        this.inFlight = p;
        try {
          const made = await p;
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof Pending) return { actualCalls, next: this.nextTask(err.resumeAt) };
          this.log(`siphoner error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }
}