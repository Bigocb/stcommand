import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { WaypointPos } from "./agent.js";
import type { MarketSnapshot } from "./market.js";
import type { Task, TaskResult } from "./scheduler.js";
import { type AgentStep, Pending } from "./agentStep.js";
import { Registry } from "./registry.js";
import { standDownReason } from "./intent.js";
import { ShipProxy } from "./shipProxy.js";

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
  /** Called with the results of a sensor scan so the fleet can ingest them. */
  onScan?: (res: { systems?: components["schemas"]["ScannedSystem"][]; waypoints?: components["schemas"]["ScannedWaypoint"][] }) => void;
  /** Minimum minutes between sensor scans. 0 disables scanning. */
  scanIntervalMin?: number;
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
  private readonly onScan: ScoutOptions["onScan"];
  private readonly scanIntervalMs: number;
  private readonly systemSymbol: string;
  private readonly intentFor?: ScoutOptions["intentFor"];
  private readonly shouldRun?: () => boolean;
  /**
   * The world, held by reference — see registry.ts. Defaults to a standalone
   * one so a scout built without a shared registry (a test, or a construction
   * that predates the fleet handing one over) still works; withRegistry()
   * swaps in the fleet's live instance, and from then on a chart or survey
   * anywhere is visible here immediately, with nothing to re-seed.
   */
  private registry: Registry = Registry.standalone();
  private readonly charted = new Set<string>();
  private readonly proxy: ShipProxy;
  /** Every `this.ship` read and write in this class goes through the one copy
   *  the proxy owns — see shipProxy.ts. */
  private get ship(): Ship { return this.proxy.getShip(); }
  private set ship(s: Ship) { this.proxy.setShip(s); }
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
  private get currentStep(): AgentStep { return this.proxy.getStep(); }
  private set currentStep(s: AgentStep) { this.proxy.setStep(s); }
  /** True only for the exact duration of nextTask()'s run() closure's call
   *  into tick() — see agentStep.ts's NavigationPending doc comment for why
   *  this is scoped this narrowly rather than a flag set once and left true:
   *  dispatchTo()-style manual dispatch also reaches navigateTo(), never
   *  through tick(), and must keep blocking exactly as before. */
  private get schedulerDriven(): boolean { return this.proxy.schedulerDriven; }
  private set schedulerDriven(v: boolean) { this.proxy.schedulerDriven = v; }

  /** What this ship is doing right now, if it's mid-navigation — see agentStep.ts. Scouts never transact. */
  getStep(): AgentStep {
    return this.currentStep;
  }

  constructor(ship: Ship, opts: ScoutOptions) {
    this.symbol = ship.symbol;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.intentFor = opts.intentFor;
    this.shouldRun = opts.shouldRun;
    this.onScan = opts.onScan;
    this.scanIntervalMs = (opts.scanIntervalMin ?? 0) * 60_000;
    this.systemSymbol = ship.nav.systemSymbol;
    // Built last: it owns the ship state every `this.ship` accessor above
    // reads through, so nothing may touch that accessor before this line.
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

  /** Seed positions and prices directly, for a scout with no shared registry. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[] = []): this {
    const standalone = this.registry as Registry & { seed?: (w: readonly WaypointPos[]) => void };
    standalone.seed?.(positions);
    this.registry.recordMarkets(markets);
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

  /** One-shot manual dispatch: chart this waypoint, then return to autonomous mode. */
  dispatchTo(waypoint: string): void {
    this.manualGoal = waypoint;
  }

  release(): void {
    this.manualGoal = null;
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

  private async navigateTo(waypoint: string): Promise<void> {
    return this.proxy.navigateTo(waypoint);
  }

  private distanceTo(wp: WaypointPos): number {
    return this.registry.distance(this.ship.nav.waypointSymbol, wp.symbol);
  }

  private estimatedFuelTo(waypoint: string): number {
    return this.registry.fuelFor(this.ship.nav.waypointSymbol, waypoint);
  }

  private estimatedFuelToBetween(a: string, b: string): number {
    return this.registry.fuelFor(a, b);
  }

  private nearestMarketTo(waypoint: string): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.registry.marketEndpoints(this.registry.systemOf(waypoint))) {
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

  private fuelNeededRoundTrip(target: string): number {
    const out = this.estimatedFuelTo(target);
    const market = this.nearestMarketTo(target);
    const back = market ? this.estimatedFuelToBetween(target, market) : out;
    return out + back + 5;
  }

  private async refuelIfNeeded(reserve: number, target?: string): Promise<boolean> {
    return this.proxy.refuelIfNeeded({ reserve, target });
  }

  /** Nearest uncharted waypoint that can be reached and returned from on one tank, or undefined. */
  private pickChartTarget(): WaypointPos | undefined {
    // Scoped to this system: a waypoint in another one needs a jump, not a
    // navigate, and registry.distance() reports Infinity across the boundary
    // anyway. Filtering here says so directly instead of relying on that.
    const candidates = this.registry
      .waypointsIn(this.ship.nav.systemSymbol)
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
          if (err instanceof Pending) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`sensor scan failed: ${msg}`);
          this.scanCooldownUntil = Date.now() + 60_000;
          return false;
        }
      }
      this.log("scout: no uncharted waypoints to chart");
      return false;
    }
    // Same rule tourScout() already follows: a false here means "not enough
    // fuel and nowhere reachable to get more", and flying the leg anyway just
    // trades that log line for a rejected navigate every 10 s.
    if (!(await this.refuelIfNeeded(5, target))) {
      this.log(`holding at ${this.ship.nav.waypointSymbol}: not enough fuel for ${target} and no reachable market`);
      return false;
    }
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
          if (err instanceof Pending) return { actualCalls, next: this.nextTask(err.resumeAt) };
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
