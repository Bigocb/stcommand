import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { WaypointPos } from "./agent.js";
import type { MarketSnapshot } from "./market.js";
import type { Task, TaskResult } from "./scheduler.js";
import { type AgentStep, IDLE_STEP, NavigationPending } from "./agentStep.js";
import { chooseFlightMode, flightModeReason } from "./flightMode.js";

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
  /** Trade symbols reserved for missions; these must never be sold/jettisoned. */
  protectedGoods?: () => Set<string>;
  /** Whether the ship may act right now. False while the fleet is halted. */
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
  private readonly waypointPositions = new Map<string, WaypointPos>();
  private readonly shouldRun?: () => boolean;
  private markets: MarketSnapshot[] = [];
  private ship: Ship;
  private suspended = false;
  /** The currently in-flight tick(), if any — suspend() awaits this so a caller
   *  about to mutate this ship's nav state directly (rescue/mission dispatch)
   *  can't race a tick that's already mid-flight against stale cached state. */
  private inFlight: Promise<unknown> | null = null;
  /** Manual override: park at this waypoint and hold until released. */
  private manualGoal: string | null = null;
  running = false;
  private currentStep: AgentStep = IDLE_STEP;
  /** True only for the exact duration of nextTask()'s run() closure's call
   *  into tick() — see agentStep.ts's NavigationPending doc comment for why
   *  this is scoped this narrowly rather than a flag set once and left true:
   *  dispatchTo()-style manual dispatch also reaches navigateTo(), never
   *  through tick(), and must keep blocking exactly as before. */
  private schedulerDriven = false;

  /** What this ship is doing right now, if it's mid-navigation or mid-transaction — see agentStep.ts. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: SiphonerOptions) {
    this.symbol = ship.symbol;
    this.ship = ship;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.shouldRun = opts.shouldRun;
    this.protectedGoods = opts.protectedGoods;
  }

  /** Seed the agent with known waypoint positions and market snapshots. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[] = []): this {
    for (const p of positions) this.waypointPositions.set(p.symbol, p);
    this.markets = markets;
    return this;
  }

  getShip(): Ship {
    return this.ship;
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

  /** True if the ship can reach the target with its current fuel. Unknown positions count as unreachable. */
  private canReach(waypoint: string): boolean {
    if (this.ship.fuel.capacity <= 0) return true;
    return this.estimatedFuelTo(waypoint) <= this.ship.fuel.current;
  }

  private estimatedFuelTo(waypoint: string): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    const there = this.waypointPositions.get(waypoint);
    if (!here || !there) return Infinity;
    return Math.max(1, Math.round(Math.hypot(there.x - here.x, there.y - here.y)));
  }

  private distanceTo(wp: WaypointPos): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (!here) return Infinity;
    return Math.hypot(wp.x - here.x, wp.y - here.y);
  }

  private cargoFree(): number {
    return this.ship.cargo.capacity - this.ship.cargo.units;
  }

  /** Nearest gas giant that is reachable now, or reachable after a refuel at a market. */
  private pickGasGiant(): WaypointPos | undefined {
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of this.waypointPositions.values()) {
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

  private estimatedFuelToBetween(a: string, b: string): number {
    const pa = this.waypointPositions.get(a);
    const pb = this.waypointPositions.get(b);
    if (!pa || !pb) return Infinity;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
  }

  /** Best market for the cargo currently held: highest total sell value, reachable with current fuel. */
  private bestSellMarket(): { symbol: string; value: number } | undefined {
    const held = this.ship.cargo.inventory.filter((i) => i.units > 0 && !(this.protectedGoods?.() ?? new Set()).has(i.symbol));
    if (held.length === 0) return undefined;
    let best: { symbol: string; value: number } | undefined;
    for (const m of this.markets) {
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

  private async navigateTo(waypoint: string): Promise<boolean> {
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") {
      return true;
    }
    await this.ensureInOrbit();
    const need = this.estimatedFuelTo(waypoint);
    // Flight mode: see flightMode.ts's own comment for the exact policy.
    // DRIFT is tried here (instead of giving up, as this used to do
    // unconditionally on an unaffordable-at-CRUISE leg) because the real
    // navigate call below is the final authority on whether the leg is
    // actually reachable, DRIFT or not — this never makes stranding worse,
    // only sometimes avoids it. A patch failure doesn't block the attempt.
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
      return true;
    } catch (err) {
      // Not a real navigation failure: tick() just started a transit, and
      // this "boolean success/failure" method has no way to express "still
      // in progress" through its return type — must propagate as a throw,
      // same as every other agent class's navigateTo(). This is the one
      // call site that used to swallow it (an unconditional `return false`
      // below, before this guard existed) — see docs/eta-scheduled-ship-
      // waits.md's audit for why this file needed special attention.
      // Deliberately no `finally` in this method: on this one path,
      // currentStep must stay "navigating" (the ship genuinely still is —
      // see trader.ts's identical navigateTo() catch for why), so every
      // OTHER exit resets it explicitly instead of a blanket finally that
      // would reset it here too.
      if (err instanceof NavigationPending) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/already located at the destination|already at the destination/i.test(msg)) {
        await this.refresh();
        this.currentStep = IDLE_STEP;
        return true;
      }
      this.log(`navigate failed: ${msg}`);
      this.currentStep = IDLE_STEP;
      return false;
    }
  }

  /** Siphon until the hold is full (or the loop safety cap trips). */
  private async siphonUntilFull(): Promise<boolean> {
    await this.ensureInOrbit();
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
        const msg = err instanceof Error ? err.message : String(err);
        if (/cooldown/i.test(msg)) {
          this.log(`siphon pending cooldown, waiting…`);
          await sleep(6_000);
          await this.refresh();
          continue;
        }
        this.log(`siphon failed: ${msg}`);
        return false;
      }
    }
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
    if (this.ship.fuel.capacity <= 0) return;
    const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
    if (this.ship.fuel.current > this.ship.fuel.capacity * 0.5) return;
    if (atMarket) {
      await this.ensureDocked();
    } else {
      const refuelStop = this.nearestReachableMarket();
      if (!refuelStop || refuelStop === this.ship.nav.waypointSymbol) return;
      this.log(`fuel low, detouring to refuel at ${refuelStop}`);
      const ok = await this.navigateTo(refuelStop);
      if (!ok) return;
      await this.ensureDocked();
    }
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

  async tick(): Promise<boolean> {
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

    // 1. Sell first: the hold is small, so a full hold means idle income.
    if (sellable.length > 0) {
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
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (here?.type === "GAS_GIANT") {
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
        this.log(`siphoner error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      } finally {
        this.inFlight = null;
      }
    }
    this.running = false;
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
        try {
          const made = await this.tick();
          return { actualCalls: this.api.getCallCount() - before, next: this.nextTask(Date.now() + (made ? 0 : 30_000)) };
        } catch (err) {
          const actualCalls = this.api.getCallCount() - before;
          if (err instanceof NavigationPending) return { actualCalls, next: this.nextTask(err.resumeAt) };
          this.log(`siphoner error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
        }
      },
    };
  }
}