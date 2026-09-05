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

export interface ScoutOptions {
  api: SpaceTradersAPI;
  /** Logger callback; defaults to console.log. */
  log?: (msg: string) => void;
  /** Optional persistence hook, called for refuel transactions. */
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
  /** Called for notable events (chart, refuel, navigate) for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Whether a waypoint carries the MARKETPLACE trait, from the galaxy atlas.
   *  `markets` only lists waypoints already snapshotted and is never refreshed
   *  after construction, so a ship can sit on a fuel station it does not know
   *  is one. */
  isMarketWaypoint?: (waypointSymbol: string) => boolean;
  /** Called with the results of a sensor scan so the fleet can ingest them. */
  onScan?: (res: { systems?: components["schemas"]["ScannedSystem"][]; waypoints?: components["schemas"]["ScannedWaypoint"][] }) => void;
  /** Minimum minutes between sensor scans. 0 disables scanning. */
  scanIntervalMin?: number;
  /** Whether the ship may act right now. False while the fleet is halted. */
  shouldRun?: () => boolean;
}


/**
 * Chart scout: flies between uncharted waypoints and charts them, revealing
 * traits for the whole server and earning a one-time credit reward. Refuels at
 * markets between targets. No cargo, no mining — just navigation + charting.
 */
export class ScoutAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: ScoutOptions["recordLedger"];
  private readonly onActivity: ScoutOptions["onActivity"];
  private readonly recordMarket: ScoutOptions["recordMarket"];
  private readonly isMarketWaypoint?: ScoutOptions["isMarketWaypoint"];
  private readonly onScan: ScoutOptions["onScan"];
  private readonly scanIntervalMs: number;
  private readonly systemSymbol: string;
  private readonly waypointPositions = new Map<string, WaypointPos>();
  private readonly shouldRun?: () => boolean;
  private markets: MarketSnapshot[] = [];
  private readonly charted = new Set<string>();
  private ship: Ship;
  private suspended = false;
  /** The currently in-flight tick(), if any — suspend() awaits this so a caller
   *  about to mutate this ship's nav state directly (rescue/mission dispatch)
   *  can't race a tick that's already mid-flight against stale cached state. */
  private inFlight: Promise<unknown> | null = null;
  private manualGoal: string | null = null;
  private lastScanAt = 0;
  private scanCooldownUntil = 0;
  private scanSystemsNext = true;
  running = false;
  private currentStep: AgentStep = IDLE_STEP;
  /** True only for the exact duration of nextTask()'s run() closure's call
   *  into tick() — see agentStep.ts's NavigationPending doc comment for why
   *  this is scoped this narrowly rather than a flag set once and left true:
   *  dispatchTo()-style manual dispatch also reaches navigateTo(), never
   *  through tick(), and must keep blocking exactly as before. */
  private schedulerDriven = false;

  /** What this ship is doing right now, if it's mid-navigation — see agentStep.ts. Scouts never transact. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: ScoutOptions) {
    this.symbol = ship.symbol;
    this.ship = ship;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.isMarketWaypoint = opts.isMarketWaypoint;
    this.shouldRun = opts.shouldRun;
    this.onScan = opts.onScan;
    this.scanIntervalMs = (opts.scanIntervalMin ?? 0) * 60_000;
    this.systemSymbol = ship.nav.systemSymbol;
  }

  /** Seed the scout with known waypoint positions and market snapshots. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[] = []): this {
    for (const p of positions) this.waypointPositions.set(p.symbol, p);
    this.markets = markets;
    return this;
  }

  /** Seed already-charted waypoints so the scout never visits them again. */
  withCharted(symbols: Iterable<string>): this {
    for (const s of symbols) this.charted.add(s);
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

  /** One-shot manual dispatch: chart this waypoint, then return to autonomous mode. */
  dispatchTo(waypoint: string): void {
    this.manualGoal = waypoint;
  }

  release(): void {
    this.manualGoal = null;
  }

  private async refresh(): Promise<void> {
    this.ship = await this.api.getShip(this.symbol);
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
    } catch (err) {
      // A NavigationPending throw means the ship is genuinely still
      // navigating — leave currentStep as "navigating" rather than
      // resetting it, same as trader.ts's identical navigateTo() catch.
      if (!(err instanceof NavigationPending)) this.currentStep = IDLE_STEP;
      throw err;
    }
  }

  private distanceTo(wp: WaypointPos): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (!here) return 0;
    return Math.hypot(wp.x - here.x, wp.y - here.y);
  }

  private estimatedFuelTo(waypoint: string): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    const there = this.waypointPositions.get(waypoint);
    if (!here || !there) return 0;
    return Math.max(1, Math.round(Math.hypot(there.x - here.x, there.y - here.y)));
  }

  private estimatedFuelToBetween(a: string, b: string): number {
    const pa = this.waypointPositions.get(a);
    const pb = this.waypointPositions.get(b);
    if (!pa || !pb) return 0;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
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

  private fuelNeededRoundTrip(target: string): number {
    const out = this.estimatedFuelTo(target);
    const market = this.nearestMarketTo(target);
    const back = market ? this.estimatedFuelToBetween(target, market) : out;
    return out + back + 5;
  }

  private async refuelIfNeeded(reserve: number, target?: string): Promise<boolean> {
    if (this.ship.fuel.capacity <= 0) return true;
    // Trait from the atlas, not merely "we have prices for it" — see the
    // isMarketWaypoint option. A ship parked on an unsnapshotted fuel station
    // otherwise reports itself stranded while standing on a pump.
    const hereWp = this.ship.nav.waypointSymbol;
    const atMarket = this.markets.some((m) => m.symbol === hereWp) || (this.isMarketWaypoint?.(hereWp) ?? false);
    const trip = target ? this.fuelNeededRoundTrip(target) : this.ship.fuel.capacity * 0.9;
    if (this.ship.fuel.current > trip + reserve) return true;
    if (atMarket) {
      await this.ensureDocked();
      this.log(`refueling (${this.ship.fuel.current}/${this.ship.fuel.capacity})`);
      try {
        const res = await this.api.refuelShip(this.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: this.symbol,
          waypointSymbol: this.ship.nav.waypointSymbol,
          type: "REFUEL",
          units: res.fuel.current,
          total: res.transaction.totalPrice,
        });
        this.onActivity?.("refuel", `${this.symbol} refueled to ${res.fuel.current}/${res.fuel.capacity}`, -res.transaction.totalPrice, this.symbol);
        this.ship = { ...this.ship, fuel: res.fuel };
        return true;
      } catch (err) {
        // The MARKETPLACE trait does not guarantee the market sells FUEL, and
        // this branch now accepts any marketplace, not just one we hold prices
        // for. Let the caller fall through rather than throwing into its tick.
        this.log(`refuel here failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const nearest = this.nearestReachableMarket();
    if (!nearest) {
      this.log(`low fuel (${this.ship.fuel.current}) and no reachable market`);
      return false;
    }
    this.log(`fuel ${this.ship.fuel.current}, heading to ${nearest} to refuel`);
    await this.navigateTo(nearest);
    return this.refuelIfNeeded(reserve, target);
  }

  /** Nearest uncharted waypoint that can be reached and returned from on one tank, or undefined. */
  private pickChartTarget(): WaypointPos | undefined {
    const candidates = [...this.waypointPositions.values()]
      .filter((w) => !this.charted.has(w.symbol))
      .filter((w) => this.ship.fuel.capacity <= 0 || this.fuelNeededRoundTrip(w.symbol) <= this.ship.fuel.capacity);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => this.distanceTo(a) - this.distanceTo(b));
    return candidates[0];
  }

  /** Can this scout run sensor scans right now? Needs a mounted array + interval/cooldown window. */
  private canScan(): boolean {
    if (this.scanIntervalMs <= 0) return false;
    if (!this.ship.mounts?.some((m) => m.symbol.startsWith("MOUNT_SENSOR_ARRAY"))) return false;
    if (Date.now() < this.scanCooldownUntil) return false;
    return Date.now() - this.lastScanAt >= this.scanIntervalMs;
  }

  /** Run one sensor scan pass (alternating systems/waypoints) and hand results to the fleet. */
  private async sensorScan(): Promise<void> {
    await this.ensureInOrbit();
    const coverCooldown = (res: { cooldown: { expiration?: string } }): void => {
      this.scanCooldownUntil = res.cooldown.expiration ? new Date(res.cooldown.expiration).getTime() + 1_000 : Date.now() + 60_000;
    };
    if (this.scanSystemsNext) {
      const res = await this.api.scanSystems(this.symbol);
      coverCooldown(res);
      this.onScan?.({ systems: res.systems });
      this.log(`sensor scan: revealed ${res.systems.length} systems`);
      this.onActivity?.("scan", `sensor scan revealed ${res.systems.length} systems`, undefined, this.symbol);
    } else {
      const res = await this.api.scanWaypoints(this.symbol);
      coverCooldown(res);
      this.onScan?.({ waypoints: res.waypoints });
      this.log(`sensor scan: revealed ${res.waypoints.length} waypoints`);
      this.onActivity?.("scan", `sensor scan revealed ${res.waypoints.length} waypoints`, undefined, this.symbol);
    }
    this.scanSystemsNext = !this.scanSystemsNext;
    this.lastScanAt = Date.now();
  }

  /** One scout pass: chart the nearest uncharted waypoint. Returns true if a chart was attempted. */
  async tick(): Promise<boolean> {
    if (this.suspended) {
      this.log("scout: suspended, holding");
      return false;
    }
    await this.refresh();
    const target = this.manualGoal ?? this.pickChartTarget()?.symbol;
    if (!target) {
      if (await this.canScan()) {
        try {
          await this.sensorScan();
          return true;
        } catch (err) {
          // sensorScan() calls ensureInOrbit() first, which can throw
          // NavigationPending if the ship happens to still be IN_TRANSIT —
          // not a scan failure, must propagate untouched to nextTask().
          if (err instanceof NavigationPending) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`sensor scan failed: ${msg}`);
          this.scanCooldownUntil = Date.now() + 60_000;
          return false;
        }
      }
      this.log("scout: no uncharted waypoints to chart");
      return false;
    }
    await this.refuelIfNeeded(5, target);
    await this.navigateTo(target);
    await this.ensureInOrbit();
    try {
      const res = await this.api.chartShip(this.symbol);
      this.charted.add(target);
      const traits = (res.waypoint.traits ?? []).map((t) => t.symbol).join(", ");
      this.log(`charted ${target} (${res.waypoint.type})${traits ? `: ${traits}` : ""}`);
      this.onActivity?.("chart", `charted ${target}${traits ? `: ${traits}` : ""}`, undefined, this.symbol);
      if (this.manualGoal === target) this.manualGoal = null;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already charted/i.test(msg)) {
        this.log(`scout: ${target} already charted, skipping`);
      } else {
        this.log(`chart failed at ${target}: ${msg}`);
      }
      this.charted.add(target); // never retry a known-charted/failed target
      if (this.manualGoal === target) this.manualGoal = null;
      return false;
    }
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
        this.log(`scout error: ${err instanceof Error ? err.message : String(err)}`);
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
      id: `${this.symbol}-scout`,
      shipSymbol: this.symbol,
      priority: 4,
      estimatedCalls: 2,
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
          if (err instanceof NavigationPending) return { actualCalls, next: this.nextTask(err.resumeAt) };
          this.log(`scout error: ${err instanceof Error ? err.message : String(err)}`);
          return { actualCalls, next: this.nextTask(Date.now() + 10_000) };
        } finally {
          this.schedulerDriven = false;
          this.inFlight = null;
        }
      },
    };
  }
}
