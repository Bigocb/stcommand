import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import { ShipAgent } from "./agent.js";
import { TraderAgent, type TraderOptions } from "./trader.js";
import { ScoutAgent } from "./scout.js";
import { SiphonerAgent } from "./siphoner.js";
import { ContractManager } from "./contract.js";
import { MissionManager } from "./mission.js";
import type { MarketSnapshot } from "./market.js";
import type { WaypointPos } from "./agent.js";
import type { Store, CargoIntent } from "../db/store.js";
import { ShipRegistry, type Owner as ShipClaimOwner, type ShipRole as ShipClaimRole } from "./shipRegistry.js";
import type { Scheduler, Task, TaskResult } from "./scheduler.js";
import { IDLE_STEP, type AgentStep } from "./agentStep.js";
import { Registry } from "./registry.js";
import { GalaxyAtlas } from "./galaxy.js";
import { SurveyPool } from "./survey.js";
import { scoreShips, type ShipScore, type ShipyardShip } from "./loadout.js";
import type { DiscordRelay } from "./discord.js";
import { Doctrine, CRITICAL_CONDITION } from "./doctrine.js";
import { getSupplyChain } from "./supplyChain.js";
import { RouteDispatcher, CROSS_SYSTEM_JUMP_COST_ESTIMATE, type DispatchRoute, type WarehouseTarget, type HaulTarget, type MissionBuyTarget, type ContractBuyTarget, type TraderAssignment } from "./dispatcher.js";

export type Ship = components["schemas"]["Ship"];
export type ShipType = components["schemas"]["ShipType"];

/** How long the cached agent credit balance stays good for. See `refreshCredits`. */
const CREDITS_TTL_MS = 30_000;

/**
 * Buy markets keepers are stationed at to keep prices fresh. Configurable via
 * the dashboard; persisted as a JSON `fleet_flags` row named `keeperMarkets`.
 *
 * Empty, not a curated list: this used to default to a hardcoded set of
 * waypoints (`X1-BY69-*`) left over from straders' original single-tenant
 * deployment's own home system — every new tenant that ever hit
 * `keeperPriorityMarkets()` had that other system's waypoints written into
 * *their own* `fleet_flags` row as if it were their configuration, since
 * that method also persists the default on first read. Real tenant data
 * contaminated with another deployment's fixture data, not just a bad
 * fallback value. A new tenant should see no curated keeper markets at all
 * until they configure their own — same as `keeperCoverList` and the
 * curated warehouse-goods list already default to off/empty.
 */
export const DEFAULT_KEEPER_MARKETS: string[] = [];

/** Roles assignable via setShipRole() — every real role except the two that aren't a ship-agent type (`warehouse` is a designation on top of whatever role a ship already has; `idle` just means no agent claims it). */
type ManualRole = Exclude<ShipClaimRole, "warehouse" | "idle">;
const MANUAL_ROLES: ReadonlySet<ManualRole> = new Set<ManualRole>(["miner", "trader", "surveyor", "tour", "keeper", "scout", "siphoner"]);

/**
 * The control surface every ship agent shares, regardless of role. Used so the
 * coordinator can command any ship uniformly instead of switch-casing on role.
 */
interface ControlledAgent {
  readonly symbol: string;
  getShip(): Ship;
  isManual(): boolean;
  isSuspended(): boolean;
  dispatchTo(waypointSymbol: string): void | Promise<void>;
  release(): void;
  /** Async: resolves once any loop iteration already in flight has finished,
   *  so callers can safely mutate this ship's nav state directly right after
   *  awaiting this — see agent.ts's `suspend()` doc comment for the race this closes. */
  suspend(): void | Promise<void>;
  resume(): void;
  /** Optional: real agent classes all implement this (see agentStep.ts); test fakes that don't are treated as always idle. */
  getStep?(): AgentStep;
}

export interface FleetOptions {
  api: SpaceTradersAPI;
  contracts?: ContractManager;
  log?: (msg: string) => void;
  store?: Store;
  /** Bound once, like Doctrine/MissionManager — this FleetManager belongs to
   *  exactly one tenant for its whole lifetime. See doctrine.ts's class doc
   *  comment for the full reasoning. */
  tenantId?: string;
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "SELL" | "REFUEL" | "PURCHASE" | "SHIP";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** Called for notable events for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  minCashReserve?: number;
  /** This tenant's own Discord relay, if they've configured a webhook — never a shared/global one. See discord.ts's class doc comment. */
  discord?: DiscordRelay;
  /**
   * Cutover (Greenfield Phase 5-7 completing): when provided, `run()` drives
   * every agent by enqueueing its `nextTask()` onto this Scheduler instead
   * of starting the old per-agent `runLoop()`-family blocking loops. When
   * omitted (the default for any caller not yet updated — most of this
   * repo's own tests), `run()` falls back to the pre-cutover behavior
   * unchanged. See README's Greenfield section for what this actually
   * changes.
   */
  scheduler?: Scheduler;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Matches TraderAgent's own default `maxLossPct` — see syncShipManifests()'s comment for why this is a fixed approximation, not each trader's actual configured value. */
const HELD_POSITION_MAX_LOSS_PCT = 15;

/** A single in-progress fuel-ferry rescue mission. */
interface TenderPlan {
  strandedSymbol: string;
  strandedWaypoint: string;
  tenderSymbol: string;
  market: string;
  fuelUnits: number;
  phase: "buy" | "transit" | "transfer" | "done";
}

/**
 * Single coordinator for the whole fleet: assigns roles, ticks every ship,
 * drives the contract pipeline, and grows the fleet by buying ships.
 */
export class FleetManager {
  private readonly api: SpaceTradersAPI;
  readonly contracts?: ContractManager;
  readonly missions: MissionManager;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: FleetOptions["recordLedger"];
  private readonly onActivity: FleetOptions["onActivity"];
  private readonly minCashReserveDefault: number;
  readonly doctrine: Doctrine;
  private systemSymbol = "";
  private positions: WaypointPos[] = [];
  private rawWaypoints: components["schemas"]["Waypoint"][] = [];
  private markets: MarketSnapshot[] = [];
  private miners = new Map<string, ShipAgent>();
  private traders = new Map<string, TraderAgent>();
  private surveyors = new Map<string, ShipAgent>();
  private scouts = new Map<string, ScoutAgent>();
  private siphoners = new Map<string, SiphonerAgent>();
  private tours = new Map<string, ShipAgent>();
  private keepers = new Map<string, ShipAgent>();
  /** Keeper ship → market it polls. Mutable so the fleet can reassign keepers. */
  private keeperMarkets = new Map<string, string>();
  /** Ships whose role was set deliberately via setShipRole()/a persisted
   *  override — never repurposed by opportunistic systems (autoExplore,
   *  promotion, etc.). Survives restarts: rehydrated from fleet_state in
   *  init()/restorePersistedManualRoles(). */
  private manualRoleShips = new Set<string>();
  private idleShips = new Map<string, Ship>();
  /**
   * The warehouse ship (docs/warehousing-plan.md §2): one designated hull,
   * held permanently at a chosen waypoint via the ordinary manual-dispatch
   * mechanism, so buy/sell-role traders have somewhere real to transfer
   * cargo to/from. Not a new role map — the ship stays wherever
   * `controlledAgent` already tracks it (miner, trader, whatever it was),
   * it's just parked and held like any other manual pin.
   */
  private warehouseShip?: { shipSymbol: string; waypointSymbol: string };
  private paused = false;
  running = false;

  private readonly surveyPool = new SurveyPool();

  private readonly store?: Store;
  private readonly tenantId?: string;
  private readonly discord?: DiscordRelay;
  private readonly galaxy: GalaxyAtlas;
  /**
   * The one world every reader should consult — see registry.ts and
   * docs/control-plane-data-plane.md §3. Built over the same live GalaxyAtlas
   * instance, so it never needs re-seeding. Agents still hold their own
   * withWorld() copies for now; each class migrating onto this reference is
   * what lets those copies (and reseedAgentWorlds/chartSystemFor with them)
   * be deleted.
   */
  private readonly registry: Registry;
  private surveyedSystems = new Set<string>();
  private lastExploreTick = 0;
  private rescuePlans = new Map<string, TenderPlan>();
  /** Why the last rescue-planning attempt for a ship failed to produce a
   *  TenderPlan at all — see makeRescuePlan()'s own comment on why this
   *  needs to be surfaced rather than just logged. Cleared once a plan is
   *  found (or the ship recovers on its own; see getStrandedShips()). */
  private rescueFailures = new Map<string, string>();
  /** Consecutive stepRescue() failures for a stranded ship's current tender
   *  plan — see tenderRescueStep()'s own comment for why this exists: without
   *  it, a plan that fails for a persistent reason (e.g. the tender's cargo
   *  filled up between planning and buying) retried the identical failing
   *  step forever, since nothing previously dropped a plan except reaching
   *  phase==="done". */
  private rescueStepFailures = new Map<string, number>();
  /** Ships currently mid-flight to a shipyard for a critical-condition repair
   *  (see maybeRepairFleet()) — prevents re-claiming/re-dispatching the same
   *  ship every tick while its dispatch is already in progress, same idea as
   *  rescuePlans above for the rescue tender's own multi-tick lifetime. */
  private repairPlans = new Set<string>();
  private maxCargoCapacity = 0;
  private credits = 0;
  private lastCreditsFetch = 0;
  private lastNegotiateAttempt = 0;
  private lastGateConstructionRefresh = 0;
  /** Centralized route dispatcher: distinct route per trader + operator overrides. */
  readonly dispatcher = new RouteDispatcher();
  /** Greenfield Phase 4: mirrors this fleet's own ownership decisions — see shipRegistry.ts and syncShipClaims(). */
  readonly shipRegistry = new ShipRegistry();
  private readonly scheduler?: Scheduler;
  /** Ship symbols that already have a live nextTask() chain enqueued on `scheduler` — see syncSchedulerTasks(). */
  private readonly scheduledShips = new Set<string>();
  /** Whether the fleet-level rescue task (see nextRescueTask()) has already been enqueued once. */
  private rescueScheduled = false;

  constructor(opts: FleetOptions) {
    this.api = opts.api;
    this.contracts = opts.contracts;
    this.log = opts.log ?? ((m) => console.log(`[fleet] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.minCashReserveDefault = opts.minCashReserve ?? 20_000;
    this.store = opts.store;
    this.tenantId = opts.tenantId;
    this.discord = opts.discord;
    this.scheduler = opts.scheduler;
    // Halt state used to be restored synchronously right here
    // (better-sqlite3 is synchronous, in-process), specifically so a halted
    // fleet stayed halted for the whole window before init()'s awaited API
    // calls resolved — never a moment of silently running unhalted right
    // after a restart. Postgres reads are inherently async, so that's no
    // longer possible from a constructor at all; `this.paused` starts false
    // here and is corrected by the first line of `init()` instead, which
    // narrows the unhalted window to "between construction and the first
    // line of init()" rather than eliminating it outright. Nothing calls
    // tick() or starts an agent loop before init() completes (see
    // src/cli/index.ts's boot sequence), so that window is never actually
    // observed in practice — but it's honest to say it exists now, where it
    // provably didn't before.
    this.doctrine = new Doctrine(opts.store, opts.tenantId);
    this.galaxy = new GalaxyAtlas(this.api, opts.store);
    this.registry = new Registry(this.galaxy);
    this.missions = new MissionManager({
      api: this.api,
      store: opts.store,
      tenantId: opts.tenantId,
      log: (m) => this.log(`mission: ${m}`),
      onActivity: opts.onActivity,
      getShip: (s) => this.api.getShip(s),
      estimatedFuelBetween: (a, b) => this.estimatedFuelBetween(a, b),
      canReach: async (shipSymbol, targetWaypoint) => this.canReachTarget(shipSymbol, targetWaypoint),
      dispatchShip: (s, w) => this.dispatchShipHop(s, w),
      pickCarrier: (exclude, targetWaypoint) => this.pickMissionCarrier(exclude, targetWaypoint),
      suspend: (s) => this.suspendAgent(s),
      resume: (s) => this.resumeAgent(s),
      listBuyers: (good, sys) => this.materialBuyers(good, sys),
      discoverBuyers: (good, sys) => this.discoverMaterialBuyers(good, sys),
      // Already floor-adjusted (see spendableCredits()'s own comment) — a
      // mission's material buying respects the cash floor with no change to
      // mission.ts itself, same trick used for every other injected agent.
      getCredits: async () => this.spendableCredits(),
      sellCargo: (s, g, u) => this.sellCargo(s, g, u),
      jettisonCargo: (s, g, u) => this.api.jettisonCargo(s, g, u),
    });
  }

  /** Load world state and register all owned ships. */
  async init(markets?: MarketSnapshot[]): Promise<void> {
    // Both reads before anything else — see the constructor's comment on why
    // this is the earliest point a halted fleet can be guaranteed to actually
    // stay halted now that the store is async.
    if (this.tenantId) this.paused = (await this.store?.getFleetFlag(this.tenantId, "paused")) === "true";
    if (this.tenantId && this.store) await this.shipRegistry.loadAllClaims(this.tenantId, this.store);
    await this.doctrine.reload();
    // Whether to stay paused pending onboarding confirmation is decided by
    // TenantRegistry.boot() (setPaused() after this returns), not here — it
    // needs tenants.onboarding_pending, a table this class has no reason to
    // know about. See migration 009's comment for why that has to be a real
    // persisted column rather than "does this tenant have any doctrine rows
    // at all": a tenant who predates onboarding and never touched Book also
    // has zero rows, but is grandfathered, not pending — inferring from row
    // presence alone force-paused DAGGER (created weeks before this
    // feature existed) on every restart.
    const agent = await this.api.getMyAgent();
    this.credits = agent.credits;
    this.systemSymbol = agent.headquarters.slice(0, agent.headquarters.lastIndexOf("-"));
    await this.galaxy.loadSystem(this.systemSymbol);
    await this.galaxy.scanJumpGates(this.systemSymbol);
    const known = this.galaxy.getSystem(this.systemSymbol)!;
    this.rawWaypoints = known.waypoints;
    this.positions = known.waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type }));
    this.markets = markets ?? [];
    this.registry.recordMarkets(this.markets);

    // Shipyard survey used to run synchronously here, blocking the entire
    // dashboard on a live API scan. It now runs as a background refresh in
    // TenantRegistry.boot() after the dashboard is already served; the dashboard
    // reads shipyards from the persisted inventory table via fleet.getIntel().

    const ships = await this.api.listAllShips();
    // Prefer the largest-cargo ship as the arbitrage trader once we have enough miners.
    this.maxCargoCapacity = Math.max(0, ...ships.map((s) => s.cargo?.capacity ?? 0));
    // Reserve every persisted keeper market up front so the coordinator never
    // re-stations a second keeper on a covered market while roles restore.
    const persistedFleetState = this.tenantId ? await this.store?.getFleetState(this.tenantId) : undefined;
    for (const r of persistedFleetState ?? []) {
      if (r.role === "keeper" && r.keeperMarket) this.keeperMarkets.set(r.shipSymbol, r.keeperMarket);
    }
    // A persisted fleet_state row means a ship's role was already decided
    // deliberately — either a runtime conversion (maybeAssignKeepers) or an
    // explicit operator override (setShipRole) — restorePersistedManualRoles()
    // below re-applies it over whatever assignRole() would derive. The
    // promotion logic further down must not then re-derive its own opinion
    // from raw cargo capacity and silently overwrite that decision (observed:
    // setting a ship to "tour" stuck until the next restart, when largest-
    // cargo promotion picked it right back up into "trader").
    const persistedRoleOverrides = new Set((persistedFleetState ?? []).map((r) => r.shipSymbol));
    for (const ship of ships) {
      if (ship.frame?.symbol) await this.doctrine.ensureShipTypeRule(ship.frame.symbol);
      await this.assignRole(ship);
    }
    // Restore converted/overridden roles immediately instead of re-crawling
    // one per coordinator pass. Ships whose role assignRole() already
    // re-derives correctly (probe → keeper, mounts → miner, etc.) are a
    // no-op here; this resurrects anything assignRole() couldn't reach on
    // its own (maybeAssignKeepers() conversions, setShipRole() overrides).
    await this.restorePersistedManualRoles(ships);
    // Promote the largest-cargo ship to trader if we have enough miners and no trader yet.
    if (this.miners.size >= 3 && this.traders.size === 0) {
      const best = ships
        .filter((s) => (s.cargo?.capacity ?? 0) >= 15)
        .filter((s) => !persistedRoleOverrides.has(s.symbol))
        .sort((a, b) => (b.cargo?.capacity ?? 0) - (a.cargo?.capacity ?? 0))[0];
      if (best) {
        this.miners.delete(best.symbol);
        this.surveyors.delete(best.symbol);
        this.traders.set(
          best.symbol,
          new TraderAgent(best, this.traderOptions(best.symbol)).withWorld(this.positions),
        );
        this.log(`role: trader ${best.symbol} (promoted, largest cargo)`);
      }
    }
    if (this.miners.size >= this.doctrine.value("promoteAtMiners", Infinity)) {
      // A mining-capable ship with a large hold (e.g. the COMMAND frigate) earns
      // far more arbitrage trading than ore. Once the drone fleet covers mining,
      // promote the biggest-hold miner to trader so it prints credits instead.
      // Belt-and-suspenders, not strictly load-bearing here: a ship with a
      // persisted override would already have been moved out of `this.miners`
      // by restorePersistedManualRoles() above, so it wouldn't reach this
      // filter in the first place — kept for the same reason as the block
      // above, in case that ordering ever changes.
      const best = [...this.miners.values()]
        .map((a) => a.getShip())
        .filter((s) => (s.cargo?.capacity ?? 0) >= 40)
        .filter((s) => !persistedRoleOverrides.has(s.symbol))
        .sort((a, b) => (b.cargo?.capacity ?? 0) - (a.cargo?.capacity ?? 0))[0];
      if (best) {
        this.miners.delete(best.symbol);
        this.traders.set(
          best.symbol,
          new TraderAgent(best, this.traderOptions(best.symbol)).withWorld(this.positions),
        );
        this.log(`role: trader ${best.symbol} (promoted, large hold)`);
      }
    }

    // Restore operator-set manual state that isn't part of a ship's role and
    // so doesn't come back from fleet_state/assignRole above: the warehouse
    // ship binding, per-ship holds/mining pins, and dispatch overrides. Each
    // replays the same mutation the corresponding UI action would make.
    const warehouseFlag = this.tenantId ? await this.store?.getFleetFlag(this.tenantId, "warehouseShip") : undefined;
    if (warehouseFlag) {
      try {
        const { shipSymbol, waypointSymbol } = JSON.parse(warehouseFlag) as { shipSymbol: string; waypointSymbol: string };
        if (ships.some((s) => s.symbol === shipSymbol)) {
          await this.designateWarehouseShip(shipSymbol, waypointSymbol);
        } else {
          if (this.tenantId) await this.store?.removeFleetFlag(this.tenantId, "warehouseShip"); // scrapped while we were down
        }
      } catch (err) {
        this.log(`restore warehouse ship failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const [shipSymbol, st] of Object.entries(await this.loadShipManualState())) {
      if (!ships.some((s) => s.symbol === shipSymbol)) continue; // scrapped while we were down
      if (st.minePin) {
        try {
          await this.mineAt(shipSymbol, st.minePin);
        } catch (err) {
          this.log(`restore mine pin ${shipSymbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (st.holdWaypoint) {
        try {
          await this.holdShip(shipSymbol);
        } catch (err) {
          this.log(`restore hold ${shipSymbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const dispatchFlag = this.tenantId ? await this.store?.getFleetFlag(this.tenantId, "dispatchManual") : undefined;
    if (dispatchFlag) {
      try {
        const all = JSON.parse(dispatchFlag) as Record<string, TraderAssignment>;
        for (const [shipSymbol, assignment] of Object.entries(all)) {
          if (ships.some((s) => s.symbol === shipSymbol)) this.dispatcher.setManual(shipSymbol, assignment);
        }
      } catch (err) {
        this.log(`restore manual dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Rehydrate MissionManager's in-memory active/paused state from whatever
    // survived to the DB. Nothing previously called startConstruction() here
    // at boot at all — it's only ever invoked by the operator's explicit
    // "start mission" action — so after every restart this.active (and
    // therefore this.paused, which only startConstruction()'s restore branch
    // ever populates) came back completely empty. Two consequences, both
    // reported live: an operator's pause silently didn't survive a restart
    // (tick() skips this.active.values(), which was empty, so a "paused"
    // mission looked identical to a forgotten one and just resumed sourcing
    // from scratch), and the dashboard couldn't even show it as paused
    // (list()'s `paused: this.paused.has(...)` read the same empty set).
    // startConstruction() itself is naturally idempotent per waypoint
    // (`if (this.active.has(waypointSymbol)) return;`), so restoring every
    // still-active mission here is exactly the boot-time counterpart to
    // restorePersistedManualRoles() above, for the one piece of state that
    // had no such counterpart before.
    if (this.tenantId) {
      const knownMissions = (await this.store?.latestMissions(this.tenantId)) ?? [];
      for (const m of knownMissions) {
        if (m.status !== "active") continue;
        try {
          await this.missions.startConstruction(m.targetWaypoint);
        } catch (err) {
          this.log(`restore mission ${m.targetWaypoint} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Persist the just-restored roles/statuses immediately rather than
    // waiting for the first coordinator tick (~2s away) — a dashboard read
    // that lands in that gap should see this boot's state, not the previous
    // process's stale rows.
    await this.syncShipStates();
    await this.syncShipManifests();
    await this.syncShipClaims();
    this.syncSchedulerTasks();
  }

  /** Live cash floor. Read from doctrine each time so an edit applies on the
   *  next tick; falls back to the value the coordinator was constructed with. */
  private minCashReserve(): number {
    return this.doctrine.value("cashFloor", 0) || this.minCashReserveDefault;
  }

  /**
   * The one gate every credit-spending action in the fleet is meant to go
   * through — ships, modules, repairs, cargo, all of it. Before this, "never
   * let the balance fall below X" was ~10 independent copies of
   * `credits < price + minCashReserve()` scattered across every ship-
   * purchase function, and several real spending paths (a trader's own
   * arbitrage/contract buying, repairShip(), a manual dashboard buy) never
   * checked it at all — a trader could spend the fleet to zero on one big
   * cargo buy with nothing stopping it. A future spending policy (max single
   * purchase, daily spend cap) extends this one function's body, not every
   * call site that spends money.
   *
   * FUEL is the one deliberate exception, and never passes through here at
   * all: SpaceTraders' own refuelShip() endpoint (used everywhere a ship
   * tops up its tank) was never routed through canAfford() to begin with,
   * and the two spots that buy FUEL as cargo instead — buyCargo()'s manual
   * dashboard purchase and the rescue tender's fuel purchase — each carry
   * their own explicit bypass. A stranded ship, or one about to run dry,
   * needs fuel more than the fleet needs its reserve protected.
   *
   * `credits` defaults to the fleet's own cached balance (kept current by
   * refreshCredits()); pass a freshly-fetched value explicitly for a path
   * that already has one on hand, to avoid an extra API call just to
   * re-derive what the caller already knows.
   */
  canAfford(amount: number, credits = this.credits): boolean {
    return this.spendableCredits(credits) >= amount;
  }

  /**
   * How much is actually free to spend, once the cash floor is set aside —
   * the sizing counterpart to canAfford()'s yes/no gate, for a purchase
   * whose per-unit cost is known but the *volume* is the decision (how many
   * units of cargo to buy). Every per-ship agent (ShipAgent/TraderAgent/
   * MissionManager) gets this injected as its own `getCredits` callback, so
   * `units = Math.floor(getCredits() / price)`-style sizing anywhere in the
   * engine already respects the floor with no other code change — it was
   * previously handed raw balance, which is exactly how a trader's own
   * arbitrage buying could spend the fleet to zero on one purchase with
   * nothing stopping it.
   */
  spendableCredits(credits = this.credits): number {
    return Math.max(0, credits - this.minCashReserve());
  }

  /** Headroom above the cash floor before a ship purchase is even considered. */
  private shipBudget(): number {
    return this.doctrine.value("shipBudget", 0);
  }

  /** Number of FRAME_DRONE hulls in the fleet (miners + surveyors + scouts). */
  private droneCount(): number {
    let n = 0;
    for (const a of this.miners.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    for (const a of this.surveyors.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    for (const a of this.scouts.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    for (const a of this.siphoners.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    return n;
  }

  /**
   * Ship count per hull (frame) type, from locally-tracked agents — no API
   * call. A ship's frame never changes after purchase, so the in-memory
   * roster (which mirrors every buy/scrap as it happens, same as
   * `droneCount` above) is exactly as authoritative as re-fetching it, and
   * far cheaper. This used to call `listAllShips()`, which pages through
   * every 20 ships — and `maybeBuyShip` runs it on every 2s coordinator
   * tick, so a fleet past 20 hulls was making multiple API calls a tick for
   * a number that already lived in memory.
   */
  private hullCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (frame?: string) => {
      const key = frame ?? "?";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    };
    for (const a of this.miners.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.traders.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.surveyors.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.tours.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.keepers.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.scouts.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.siphoners.values()) bump(a.getShip().frame?.symbol);
    for (const s of this.idleShips.values()) bump(s.frame?.symbol);
    return counts;
  }

  getSystemSymbol(): string {
    return this.systemSymbol;
  }

  /** Expose the multi-system atlas for server/state use. */
  getGalaxy(): GalaxyAtlas {
    return this.galaxy;
  }

  getApi(): SpaceTradersAPI {
    return this.api;
  }

  /** How long a market price stays usable. One number, read by everyone. */
  private intelMaxAgeMin(): number {
    // Disabled means "don't filter", not "filter to zero" — a decade of minutes.
    return this.doctrine.value("snapshotMaxAgeMin", 5_256_000);
  }

  /**
   * The market view the whole fleet flies by. The dispatcher ranks routes from
   * this same window (`computeDispatchRoutes`), so when intel goes stale both
   * sides lose the same markets at the same moment. They used to disagree —
   * the dispatcher filtered by age, the traders didn't — so an aged-out market
   * left the dispatcher with no routes to hand out while every trader still
   * saw it, ran the same scoring function over the same stale table, and
   * independently picked the same "best" good.
   */
  private async freshSnapshots(): Promise<{ waypointSymbol: string; goodSymbol: string; purchasePrice: number; sellPrice: number; tradeVolume: number }[]> {
    const rows = await this.store?.freshMarketSnapshots(this.intelMaxAgeMin());
    return (
      rows?.map((s) => ({
        waypointSymbol: s.waypointSymbol,
        goodSymbol: s.goodSymbol,
        purchasePrice: s.purchasePrice,
        sellPrice: s.sellPrice,
        tradeVolume: s.tradeVolume,
      })) ?? []
    );
  }

  /**
   * Goods no ship's sell/jettison path may touch: active construction-mission
   * materials plus every accepted contract's outstanding deliverable. Every
   * protectedGoods() call site in this file goes through here — previously
   * they went straight to `this.missions.protectedGoods()`, which meant a
   * contract good in a ship's hold had no protection at all and could be
   * sold (or jettisoned, if no market would buy it) before the contract
   * ever got a chance to be fulfilled.
   */
  private allProtectedGoods(): Set<string> {
    const out = new Set(this.missions.protectedGoods());
    for (const g of this.contracts?.protectedGoods() ?? []) out.add(g);
    return out;
  }

  /**
   * The options every trader is built with. Kept in one place so all three
   * construction sites (promotion by hold size, promotion at miner count, and
   * initial role assignment) can't drift apart — they did, and a trader built
   * on one path reasoned about different markets than one built on another.
   */

  private traderOptions(shipSymbol: string): TraderOptions {
    return {
      api: this.api,
      log: (m) => this.log(`${shipSymbol}: ${m}`),
      recordLedger: this.recordLedger,
      onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
      recordMarket: (wp) => this.recordMarketSnapshot(wp),
      getMarketSnapshots: () => this.freshSnapshots(),
      intelMaxAgeMin: () => this.intelMaxAgeMin(),
      atlas: this.galaxy,
      shouldRun: () => !this.paused,
      // Prefer what this ship itself last paid; fall back to the fleet-wide
      // average for cargo it received by transfer rather than purchase.
      recoverCostBasis: async (good) => {
        if (!this.tenantId) return undefined;
        return (
          (await this.store?.lastPurchasePrice(this.tenantId, shipSymbol, good)) ??
          (await this.store?.avgPurchasePrice(this.tenantId, good))
        );
      },
      protectedGoods: () => this.allProtectedGoods(),
      deliverCargo: (s) => this.contracts?.deliverVia(s) ?? Promise.resolve(null),
      contractNeeded: (good) => this.contracts?.outstandingUnitsFor(good) ?? Promise.resolve(0),
      reservedGoods: () => this.reservedTradeGoods(shipSymbol),
      assignedRoute: () => this.dispatcher.assignmentFor(shipSymbol),
      claimRoute: (accept) => this.dispatcher.claim(shipSymbol, (r) => accept(r)),
      releaseRoute: () => this.dispatcher.release(shipSymbol),
      // Already floor-adjusted — see spendableCredits()'s own comment.
      getCredits: () => this.spendableCredits(),
      maxLossPct: this.doctrine.value("maxLossPct", 100),
      marginFloor: this.doctrine.value("marginFloor", 0),
      recordDoctrineFire: (key) => this.doctrine.recordFire(key, shipSymbol),
      getWarehouseShip: () => this.getWarehouseShip(),
      warehouseBalance: async (good) => {
        if (!this.tenantId) return 0;
        return (await this.store?.warehouseBalance(this.tenantId, good)) ?? 0;
      },
      warehouseDeposit: async (good, units, price, shipSymbol) => {
        if (!this.tenantId) return;
        await this.store?.warehouseDeposit(this.tenantId, good, units, price, shipSymbol, "buy");
      },
      warehouseWithdraw: async (good, units, shipSymbol) => {
        if (!this.store || !this.tenantId) return { units: 0, avgCost: 0 };
        const current = (await this.store.warehouseAll(this.tenantId)).find((g) => g.goodSymbol === good)?.avgCost ?? 0;
        return this.store.warehouseWithdraw(this.tenantId, good, units, current, shipSymbol, "sell");
      },
      warehouseMinMargin: () => this.doctrine.value("warehouseMinMargin", 0),
    };
  }

  /** Collect trade symbols currently held by other trader ships, so no two traders compete on the same route. */
  private reservedTradeGoods(excludeSymbol?: string): Set<string> {
    const goods = new Set<string>();
    for (const [symbol, trader] of this.traders) {
      if (symbol === excludeSymbol) continue;
      const cargo = trader.getShip().cargo?.inventory ?? [];
      for (const item of cargo) if (item.units > 0) goods.add(item.symbol);
    }
    // Also reserve goods the dispatcher assigned to OTHER traders, so a trader
    // whose own assignment is temporarily unviable can't free-pick a good that
    // belongs to a fleetmate (which is how all traders ended up on EQUIPMENT).
    for (const a of this.dispatcher.list()) {
      if (a.shipSymbol === excludeSymbol) continue;
      goods.add(a.good);
    }
    return goods;
  }

  /**
   * Traders eligible for a dispatcher assignment this cycle. The warehouse
   * ship is excluded — it's parked under a permanent manual hold and would
   * never act on an assignment, but without this it could still claim a
   * good's slot and lock real traders out of it.
   *
   * That reasoning applies to every ship that can't act, not just the
   * warehouse — and it used to be applied only to the warehouse. A trader
   * suspended as a mission carrier, or sitting on an operator Hold, still
   * received an assignment, and an assignment reserves its good against the
   * *entire* rest of the fleet. On a long construction mission that locked the
   * fleet's most profitable route away for hours behind a ship parked at a
   * building site, doing nothing with it.
   */
  private dispatcherTraders(): { shipSymbol: string; capacity: number; busy: boolean }[] {
    // "auto" is the weakest owner in ShipRegistry's precedence, so
    // availableFor("auto") answers exactly "not held, not suspended, not
    // committed to a mission/warehouse/keeper claim" — same intent as the
    // old !isManual() && !isSuspended() check, now backed by the one shared
    // definition (see docs/ship-control-state-audit.md, Phase 1). The
    // explicit warehouseShip filter below is now redundant (the warehouse
    // ship's claim already excludes it here) but kept as cheap defense-in-
    // depth rather than trusting that alone.
    const available = this.availableFor("auto");
    return [...this.traders.entries()]
      .filter(([sym]) => sym !== this.warehouseShip?.shipSymbol)
      .filter(([sym]) => available.has(sym))
      .map(([sym, a]) => ({
        shipSymbol: sym,
        capacity: a.getShip().cargo?.capacity ?? 0,
        // Cargo in the hold means the ship is mid-haul on its current route.
        // Reassigning it there strands that cargo, so the dispatcher leaves it be.
        busy: (a.getShip().cargo?.units ?? 0) > 0,
      }));
  }

  /**
   * Per-good warehouse targets for the dispatcher's buy/sell split. Gated
   * behind `warehouseTarget`'s own enabled flag — the master switch for
   * warehousing: disabled (the default) means nothing is targeted, so
   * `recompute` only ever emits "direct" assignments, same as before tracer
   * 2 existed. Only goods on the curated list (`warehouse_targets`) are
   * ever bought/sold through the warehouse, however profitable their route —
   * without an operator explicitly adding a good, it just trades direct.
   * `warehouseMax` still bounds every per-good target, so a target set
   * above the cap never asks a buy trader to overfill the hold.
   */
  private async computeWarehouseTargets(routes: DispatchRoute[]): Promise<WarehouseTarget[]> {
    if (!this.doctrine.isEnabled("warehouseTarget")) return [];
    const curated = (this.tenantId ? await this.store?.warehouseTargetList(this.tenantId) : undefined) ?? [];
    if (!curated.length) return [];
    const max = this.doctrine.value("warehouseMax", Infinity);
    const routedGoods = new Set(routes.map((r) => r.good));
    const eligible = curated.filter((c) => !c.forMission && routedGoods.has(c.goodSymbol));
    const out: WarehouseTarget[] = [];
    for (const c of eligible) {
      const balance = (this.tenantId ? await this.store?.warehouseBalance(this.tenantId, c.goodSymbol) : undefined) ?? 0;
      out.push({ good: c.goodSymbol, target: Math.min(c.target, max), balance });
    }
    return out;
  }

  /**
   * Mission materials the warehouse already holds stock of. Gated behind the
   * same `warehouseTarget` master switch as `computeWarehouseTargets` —
   * hauling is a warehousing behavior (it withdraws from the warehouse ship),
   * so it stays off with the rest of the feature until the operator opts in.
   * Does not by itself create demand for mission goods to be bought into the
   * warehouse — `computeMissionBuyTargets` is the pathway for that, and only
   * for goods explicitly flagged "buy for mission" on the curated list.
   */
  private async computeHaulTargets(): Promise<HaulTarget[]> {
    if (!this.doctrine.isEnabled("warehouseTarget")) return [];
    const targets: HaulTarget[] = [];
    for (const m of await this.missions.list()) {
      if (m.status !== "active" || m.paused) continue;
      for (const mat of m.materials) {
        const needed = mat.required - mat.fulfilled;
        if (needed <= 0) continue;
        const balance = (this.tenantId ? await this.store?.warehouseBalance(this.tenantId, mat.tradeSymbol) : undefined) ?? 0;
        if (balance <= 0) continue;
        targets.push({ good: mat.tradeSymbol, targetWaypoint: m.targetWaypoint, needed, balance });
      }
    }
    return targets;
  }

  /**
   * Goods flagged "buy for mission" on the curated list, with an active,
   * unpaused mission currently short of them. Unlike ordinary warehousing
   * there's usually no profitable resale route to source from — this reuses
   * `materialBuyers`, the same cheapest-known-market lookup MissionManager's
   * own carrier sources from, instead of `computeDispatchRoutes`. Gated
   * behind the same warehouseTarget master switch as the rest of warehousing.
   */
  private async computeMissionBuyTargets(): Promise<MissionBuyTarget[]> {
    if (!this.doctrine.isEnabled("warehouseTarget")) return [];
    const curated = (this.tenantId ? await this.store?.warehouseTargetList(this.tenantId) : undefined) ?? [];
    const forMissionGoods = new Set(curated.filter((c) => c.forMission).map((c) => c.goodSymbol));
    if (!forMissionGoods.size) return [];
    const targets: MissionBuyTarget[] = [];
    for (const m of await this.missions.list()) {
      if (m.status !== "active" || m.paused) continue;
      for (const mat of m.materials) {
        if (!forMissionGoods.has(mat.tradeSymbol)) continue;
        const needed = mat.required - mat.fulfilled;
        if (needed <= 0) continue;
        const cheapest = (await this.materialBuyers(mat.tradeSymbol, m.targetSystem))[0];
        if (!cheapest) continue; // no known market for it yet
        const balance = (this.tenantId ? await this.store?.warehouseBalance(this.tenantId, mat.tradeSymbol) : undefined) ?? 0;
        targets.push({ good: mat.tradeSymbol, buyAt: cheapest.waypoint, buyPrice: cheapest.purchasePrice, needed, balance });
      }
    }
    return targets;
  }

  /**
   * Goods an accepted contract still needs delivered, sourced from the
   * cheapest known market — the contract equivalent of
   * computeMissionBuyTargets(), minus the warehouseTarget gating: unlike
   * mission-buy (which only sources goods an operator explicitly curated
   * for that purpose), contract sourcing is always on once a contract is
   * accepted. There's no "hold it in the warehouse" step either — see
   * TraderRole's own comment on why "contractBuy" skips straight to
   * carrying it.
   */
  private async computeContractBuyTargets(): Promise<ContractBuyTarget[]> {
    if (!this.contracts) return [];
    const deliveries = await this.contracts.outstandingDeliveries();
    const neededByGood = new Map<string, number>();
    // A contract pays out once, on full completion — attribute its whole
    // onFulfilled payout to every good it still needs, but only once per
    // contract per good, so a duplicate line (or this loop re-adding the
    // same contract) can't double count it.
    const valueByGood = new Map<string, number>();
    const countedContractForGood = new Set<string>();
    for (const d of deliveries) {
      const needed = d.unitsRequired - d.unitsFulfilled;
      if (needed <= 0) continue;
      neededByGood.set(d.tradeSymbol, (neededByGood.get(d.tradeSymbol) ?? 0) + needed);
      const key = `${d.tradeSymbol}:${d.contractId}`;
      if (!countedContractForGood.has(key)) {
        countedContractForGood.add(key);
        valueByGood.set(d.tradeSymbol, (valueByGood.get(d.tradeSymbol) ?? 0) + d.onFulfilledPayment);
      }
    }
    const targets: ContractBuyTarget[] = [];
    for (const [good, needed] of neededByGood) {
      const cheapest = (await this.materialBuyers(good, this.systemSymbol))[0];
      if (!cheapest) continue; // no known market — e.g. a raw ore only ever obtained by mining
      targets.push({ good, buyAt: cheapest.waypoint, buyPrice: cheapest.purchasePrice, needed, value: valueByGood.get(good) });
    }
    return targets;
  }

  /**
   * A manual contractBuy override (assignContractCarrier()) is respected
   * indefinitely, same as any other manual dispatch override — but unlike
   * an auto contractBuy assignment, nothing ever naturally clears it once
   * the contract it was pinned for is done: computeContractBuyTargets()
   * simply stops listing the good (needed drops to 0), which only matters
   * to the AUTO assignment path (manual always wins over auto, so the
   * dispatcher never even looks at whether the good is still needed).
   * Confirmed live: a ship manually pinned to a contract's good kept
   * showing "contractBuy" on the dashboard, still holding the route, well
   * after that contract had fully paid out. Called every tick, right
   * before recompute(), with the same freshly computed target list —
   * releases any manual contractBuy assignment whose good no longer
   * appears in it.
   */
  private async releaseFulfilledManualContractBuys(contractBuyTargets: ContractBuyTarget[]): Promise<void> {
    const stillNeeded = new Set(contractBuyTargets.map((t) => t.good));
    for (const a of this.dispatcher.list()) {
      if (a.role === "contractBuy" && a.source === "manual" && !stillNeeded.has(a.good)) {
        await this.setManualDispatch(a.shipSymbol, undefined);
        this.log(`${a.shipSymbol}: contract for ${a.good} is no longer outstanding — clearing manual assignment`);
      }
    }
  }

  /** The curated list of goods the warehouse is allowed to buy/sell — a good
   *  with no entry here is never warehoused, however profitable its route. */
  async warehouseTargetList(): Promise<{ goodSymbol: string; target: number; forMission: boolean }[]> {
    return (this.tenantId ? await this.store?.warehouseTargetList(this.tenantId) : undefined) ?? [];
  }

  /** Add a good to the curated list, or update its target/forMission flag. */
  async setWarehouseTarget(goodSymbol: string, target: number, forMission: boolean): Promise<void> {
    if (!this.store || !this.tenantId) throw new Error("store not available");
    if (target <= 0) throw new Error("target must be a positive number");
    await this.store.setWarehouseTarget(this.tenantId, goodSymbol, target, forMission);
  }

  /** Remove a good from the curated list — it stops being bought/sold through the warehouse. */
  async removeWarehouseTarget(goodSymbol: string): Promise<void> {
    if (this.tenantId) await this.store?.removeWarehouseTarget(this.tenantId, goodSymbol);
  }

  /** Compute all profitable trade routes (net of fuel), ranked by profit per trip. */
  /**
   * Operator override for which trader runs which route. Routes through here
   * (rather than `dispatcher.setManual` directly) so the override survives a
   * restart — persisted as one `fleet_flags` JSON blob, same mechanism as
   * `shipManualState`.
   */
  async setManualDispatch(shipSymbol: string, assignment: TraderAssignment | undefined): Promise<void> {
    this.dispatcher.setManual(shipSymbol, assignment);
    const raw = this.tenantId ? await this.store?.getFleetFlag(this.tenantId, "dispatchManual") : undefined;
    let all: Record<string, TraderAssignment> = {};
    if (raw) {
      try {
        all = JSON.parse(raw);
      } catch {
        all = {};
      }
    }
    if (assignment) all[shipSymbol] = { ...assignment, source: "manual" };
    else delete all[shipSymbol];
    if (!this.tenantId) return;
    if (Object.keys(all).length === 0) await this.store?.removeFleetFlag(this.tenantId, "dispatchManual");
    else await this.store?.setFleetFlag(this.tenantId, "dispatchManual", JSON.stringify(all));
  }

  /** Jump-leg cost estimate for a route computed from raw trade legs — the
   *  learned per-gate-pair average from real jumpShip() transactions where
   *  one exists, or the flat placeholder for a pair never actually jumped
   *  yet. See GalaxyAtlas.recordJumpCost()'s and
   *  CROSS_SYSTEM_JUMP_COST_ESTIMATE's own comments. */
  private crossSystemLegCost(buySystem: string, sellSystem: string): number {
    const gate = this.galaxy.gatesTo(buySystem, sellSystem)[0];
    const learned = gate ? this.galaxy.learnedJumpCost(gate, sellSystem) : undefined;
    return learned ?? CROSS_SYSTEM_JUMP_COST_ESTIMATE;
  }

  async computeDispatchRoutes(): Promise<DispatchRoute[]> {
    const positions = new Map<string, { x: number; y: number }>();
    for (const p of this.galaxy.allPositions()) positions.set(p.symbol, { x: p.x, y: p.y });
    const fuelAt = new Map<string, number>();
    for (const s of (await this.store?.latestMarketSnapshots()) ?? []) {
      if (s.goodSymbol === "FUEL" && s.purchasePrice > 0) fuelAt.set(s.waypointSymbol, s.purchasePrice);
    }
    const legs = (await this.store?.tradeLegs(this.intelMaxAgeMin())) ?? [];
    // Deliberately NOT filtered by gate reachability here: a "buy" or
    // "sell" assignment only needs its own side of the leg (buyAt, or
    // sellAt) to be reachable from the warehouse — not that buyAt and
    // sellAt are mutually reachable — so excluding a whole leg here would
    // wrongly drop a legitimate buy-only or sell-only opportunity whose
    // *other* side happens to sit across an unopened gate. Reachability for
    // the one role that genuinely needs buyAt/sellAt to agree (`direct`, a
    // single ship's round trip) is checked in RouteDispatcher.recompute()
    // via the canJump predicate passed to it below; runBuy()/runSell()/
    // runHaul() check their own side against the warehouse ship's system
    // independently in trader.ts.
    return legs
      .map((l) => {
        const crossSystem = l.buySystem !== l.sellSystem;
        // Waypoint coordinates are per-system — Math.hypot() between a
        // buyAt in one system and a sellAt in another compares two
        // unrelated coordinate spaces and means nothing, so a cross-system
        // leg skips distance entirely. Cost comes from the same learned
        // per-gate-pair average trader.ts's tripCost() uses (real jump
        // transactions, recorded as they happen — see
        // GalaxyAtlas.recordJumpCost()'s own comment), falling back to the
        // flat CROSS_SYSTEM_JUMP_COST_ESTIMATE placeholder for a gate pair
        // never actually jumped yet.
        const a = crossSystem ? undefined : positions.get(l.buyAt);
        const b = crossSystem ? undefined : positions.get(l.sellAt);
        const dist = a && b ? Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y))) : null;
        // Match the trader's own profitability model: one-way fuel cost. The
        // return leg is the next buy run, not a cost of this trip.
        const fuelUnits = dist === null ? null : dist;
        const fuelCost = crossSystem
          ? this.crossSystemLegCost(l.buySystem, l.sellSystem)
          : fuelUnits === null ? 0 : fuelUnits * (fuelAt.get(l.buyAt) ?? 72);
        const gross = (l.sellPrice - l.buyPrice) * l.volume;
        const profitPerTrip = Math.round(gross - fuelCost);
        return {
          good: l.goodSymbol,
          buyAt: l.buyAt,
          buySystem: l.buySystem,
          buyPrice: l.buyPrice,
          sellAt: l.sellAt,
          sellSystem: l.sellSystem,
          sellPrice: l.sellPrice,
          volume: l.volume,
          distance: dist ?? 0,
          fuelUnits: fuelUnits ?? 0,
          fuelCost: Math.round(fuelCost),
          profitPerTrip,
          ageMinutes: Math.round((Date.now() - new Date(l.stalestIso).getTime()) / 60_000),
        };
      })
      .filter((r) => r.profitPerTrip > 0)
      .sort((a, b) => b.profitPerTrip - a.profitPerTrip);
  }

  /** Refresh a system's waypoints, markets and shipyards (used after jumping/scouting). */
  async surveySystem(systemSymbol: string): Promise<void> {
    await this.galaxy.loadSystem(systemSymbol);
    await this.galaxy.scanJumpGates(systemSymbol);
    this.log(`surveyMarkets: fetching markets in ${systemSymbol}`);
    const markets = await this.galaxy.surveyMarkets(systemSymbol, this.store);
    const shipyards = await this.galaxy.surveyShipyards(systemSymbol, this.store);
    for (const m of markets) {
      for (const g of Object.values(m.tradeGoods)) {
        await this.store?.recordMarket({
          systemSymbol,
          waypointSymbol: m.symbol,
          goodSymbol: g.symbol,
          type: g.type,
          supply: g.supply,
          purchasePrice: g.purchasePrice,
          sellPrice: g.sellPrice,
          tradeVolume: g.tradeVolume,
        });
      }
    }
    this.markets = [...this.markets.filter((m) => m.systemSymbol !== systemSymbol), ...markets];
    this.positions = this.galaxy.allPositions().map((p) => ({ symbol: p.symbol, x: p.x, y: p.y, type: p.type }));
    this.registry.recordMarkets(markets);
    this.registry.noteTopologyChanged();
    // A survey is the main way the fleet learns a new system exists. Handing
    // that straight to the ships is the whole point — without it they keep
    // navigating against whatever they knew when they were built.
    this.reseedAgentWorlds();
    this.log(`surveyed ${systemSymbol}: ${markets.length} markets, ${shipyards.length} shipyards`);
  }

  /**
   * Load `systemSymbol`'s waypoints and push their coordinates into
   * `shipSymbol`'s agent.
   *
   * Agents cache waypoint positions once, via withWorld(), when they are
   * constructed — and at boot this.positions holds the home system alone (see
   * init()). Any ship parked elsewhere therefore restarts with no coordinates
   * for the system it is standing in, so every distance it computes is
   * Infinity: a tour scout rejects its whole target list and idles forever,
   * and estimatedFuelTo() reads legs as free and picks CRUISE for hops the
   * real navigate call then rejects. Wired in as agents' ensureSystemCharted
   * so they can repair their own cache on the first tick that notices the gap,
   * which also covers systems explored after the agent was built.
   */
  private async chartSystemFor(shipSymbol: string, systemSymbol: string): Promise<void> {
    await this.galaxy.loadSystem(systemSymbol);
    this.positions = this.galaxy.allPositions().map((p) => ({ symbol: p.symbol, x: p.x, y: p.y, type: p.type }));
    this.registry.noteTopologyChanged();
    this.reseedAgentWorlds();
  }

  /**
   * Push the current positions and market snapshots into every agent.
   *
   * Agents copy this world once, via withWorld(), when they are constructed,
   * and nothing gave it back to them afterwards — so a ship's idea of where
   * things are is frozen at the moment its agent object was built. Each role
   * that noticed independently got its own patch (a lazy ensureSystemCharted
   * hook for tour scouts, for one), while traders got nothing at all: their
   * distBetween() falls back to a fabricated 1000 for any waypoint outside
   * that first snapshot, which is enough to send a full-tank ship into DRIFT.
   * Re-seed everyone wherever the fleet's own view changes instead.
   */
  private reseedAgentWorlds(): void {
    for (const a of this.miners.values()) a.withWorld(this.positions, this.markets);
    for (const a of this.surveyors.values()) a.withWorld(this.positions, this.markets);
    for (const a of this.tours.values()) a.withWorld(this.positions, this.markets);
    for (const a of this.keepers.values()) a.withWorld(this.positions, this.markets);
    for (const a of this.scouts.values()) a.withWorld(this.positions, this.markets);
    for (const a of this.siphoners.values()) a.withWorld(this.positions, this.markets);
    for (const a of this.traders.values()) a.withWorld(this.positions);
  }

  /**
   * Whether a waypoint carries the MARKETPLACE trait. Authoritative, and the
   * same check recordMarketSnapshot() makes below — unlike `this.markets`,
   * which only lists waypoints already snapshotted and is never refreshed on
   * an agent after it is constructed.
   */
  private isMarketWaypoint(waypointSymbol: string): boolean {
    return this.registry.isMarket(waypointSymbol);
  }

  /** The live world, for readers migrating off their own withWorld() copy. */
  getRegistry(): Registry {
    return this.registry;
  }

  /** Snapshot current market prices at a waypoint if it has a MARKETPLACE trait.
   *  Called whenever a ship docks so the dashboard stays current. */
  async recordMarketSnapshot(waypointSymbol: string): Promise<void> {
    const systemSymbol = this.registry.systemOf(waypointSymbol);
    if (!this.registry.isMarket(waypointSymbol)) return;
    try {
      const market = await this.api.getMarket(systemSymbol, waypointSymbol);
      const goods = market.tradeGoods ?? [];
      if (!goods.length) return;
      const moduleGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
      const mountGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
      for (const g of goods) {
        await this.store?.recordMarket({
          systemSymbol,
          waypointSymbol,
          goodSymbol: g.symbol,
          type: g.type,
          supply: g.supply,
          purchasePrice: g.purchasePrice,
          sellPrice: g.sellPrice,
          tradeVolume: g.tradeVolume,
        });
        if (g.symbol.startsWith("MODULE_")) {
          moduleGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
        } else if (g.symbol.startsWith("MOUNT_")) {
          mountGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
        }
      }
      if (moduleGoods.length) await this.store?.recordModuleCatalog(systemSymbol, waypointSymbol, moduleGoods, "module");
      if (mountGoods.length) await this.store?.recordModuleCatalog(systemSymbol, waypointSymbol, mountGoods, "mount");
      // Prices went to Postgres but never to the in-memory world, so the only
      // thing that ever refreshed it was a full surveySystem() — every dock in
      // between published prices the fleet's own ships could not see. The
      // registry is the live copy, so record it here too.
      this.registry.recordMarket({
        symbol: waypointSymbol,
        systemSymbol,
        tradeGoods: Object.fromEntries(goods.map((g) => [g.symbol, g])),
        imports: (market.imports ?? []).map((g) => g.symbol),
        exports: (market.exports ?? []).map((g) => g.symbol),
        exchange: (market.exchange ?? []).map((g) => g.symbol),
        fetchedAt: new Date().toISOString(),
      });
      this.onActivity?.("market", `snapshot ${waypointSymbol} (${goods.length} goods)`, 0);
    } catch (err) {
      // ignore: market may not be scannable
    }
  }

  /** Decide a ship's role: miner (has mining mount + cargo) vs trader (cargo) vs scout vs idle. */
  private async assignRole(ship: Ship): Promise<void> {
    const hasMining = ship.mounts.some((m) => m.symbol.startsWith("MOUNT_MINING_LASER"));
    const hasSurveyor = ship.mounts.some((m) => m.symbol.startsWith("MOUNT_SURVEYOR"));
    const hasGasSiphon = ship.mounts.some((m) => m.symbol.startsWith("MOUNT_GAS_SIPHON"));
    const hasCargo = ship.cargo.capacity >= 15;
    // Once we have enough miners, dedicate a cargo-capable ship to arbitrage trading
    // (CLOTHING/JEWELRY/MEDICINE → A1 etc.) which out-earns raw ore mining.
    // Prefer the largest-cargo ship (e.g. the COMMAND frigate) as the trader.
    const wantTrader = false;
    if (hasMining && hasCargo && !wantTrader) {
      this.miners.set(
        ship.symbol,
        new ShipAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
          deliverCargo: (s) => this.contracts?.deliverVia(s) ?? Promise.resolve(null),
          surveyPool: this.surveyPool,
          protectedGoods: () => this.allProtectedGoods(),
          getCredits: () => this.spendableCredits(),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: miner ${ship.symbol}`);
    } else if (hasSurveyor) {
      this.surveyors.set(
        ship.symbol,
        new ShipAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
          surveyPool: this.surveyPool,
          protectedGoods: () => this.allProtectedGoods(),
          ensureSystemCharted: (sys) => this.chartSystemFor(ship.symbol, sys),
          marketTourTargets: () => this.marketTourTargets(),
          shipyardTourTargets: () => this.shipyardTourTargets(),
          recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
          getCredits: () => this.spendableCredits(),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: surveyor ${ship.symbol}`);
    } else if (hasGasSiphon) {
      // Siphon drone: dedicated to gas-giant extraction (HYDROCARBON etc.), a
      // second raw-income floor that doesn't compete with the miners' asteroids.
      this.siphoners.set(
        ship.symbol,
        new SiphonerAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
          protectedGoods: () => this.allProtectedGoods(),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: siphoner ${ship.symbol}`);
    } else if (ship.registration.role === "SATELLITE" || ship.frame?.symbol === "FRAME_PROBE") {
      // Probes/satellites: 0 fuel, 0 cargo, 0 mounts — they can't move, mine or
      // trade. But a probe parked at a shipyard-market keeps that market's
      // prices permanently fresh (market data is only visible when one of our
      // ships is at the waypoint). Chart the waypoint first (free credits +
      // traits), then park as a keeper.
      const keeperMarket = this.keeperMarketFor(ship);
      if (keeperMarket) {
        // Chart the spawn waypoint first: free credits + reveals traits. The
        // probe is sitting right there, so this costs nothing but one call.
        try {
          const charted = await this.api.chartShip(ship.symbol);
          this.onActivity?.("chart", `${ship.symbol} charted ${charted.waypoint.symbol}`, 0);
        } catch (err) {
          // chart may already be done or the waypoint unchartable; ignore
        }
        this.keepers.set(
          ship.symbol,
          new ShipAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${ship.symbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
            recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
            keeperMarket: () => this.keeperMarkets.get(ship.symbol),
            getCredits: () => this.spendableCredits(),
          }).withWorld(this.positions, this.markets),
        );
        this.keeperMarkets.set(ship.symbol, keeperMarket);
        if (this.tenantId) await this.store?.setFleetState(this.tenantId, ship.symbol, "keeper", keeperMarket);
        this.log(`role: keeper ${ship.symbol} (stationed at ${keeperMarket})`);
      } else {
        this.idleShips.set(ship.symbol, ship);
        this.log(`role: idle ${ship.symbol} (satellite: no keeper market)`);
      }
    } else if (ship.frame?.symbol === "FRAME_SHUTTLE") {
      // Light shuttle: no cargo, no mining — dedicated to touring markets & shipyards
      // so price snapshots and ship-stock intel stay fresh.
      this.tours.set(
        ship.symbol,
        new ShipAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
          ensureSystemCharted: (sys) => this.chartSystemFor(ship.symbol, sys),
          marketTourTargets: () => this.sectorTourTargets(ship.symbol),
          staleMarketTargets: () => this.staleMarketTargets(),
          shipyardTourTargets: () => this.shipyardTourTargets(),
          recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
          getCredits: () => this.spendableCredits(),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: tour ${ship.symbol} (market/shipyard intel)`);
    } else if (hasCargo) {
      this.traders.set(
        ship.symbol,
        new TraderAgent(ship, this.traderOptions(ship.symbol)).withWorld(this.positions),
      );
      this.log(`role: trader ${ship.symbol}`);
    } else {
      // Chart scout: no cargo, no mining — flies to uncharted waypoints and charts them.
      this.registerScout(ship);
    }
    // The run() loop array is built at startup, so a ship assigned a role
    // mid-run (purchase, promotion) needs its loop launched here — same
    // pattern as keeper conversions.
    if (this.running) {
      void this.traders.get(ship.symbol)?.runLoop(1_000_000);
      void this.miners.get(ship.symbol)?.runLoop(1_000_000);
      void this.surveyors.get(ship.symbol)?.surveyLoop(1_000_000);
      void this.tours.get(ship.symbol)?.tourLoop(1_000_000);
      void this.scouts.get(ship.symbol)?.runLoop(1_000_000);
      void this.siphoners.get(ship.symbol)?.runLoop(1_000_000);
      if (this.keepers.get(ship.symbol) && ship.frame?.symbol === "FRAME_PROBE") {
        void this.keepers.get(ship.symbol)!.keeperLoop(1_000_000);
      }
    }
  }

  /**
   * Resurrect any ship whose persisted `fleet_state` role disagrees with
   * what `assignRole()` just derived for it from mounts/frame — a runtime
   * decision (maybeAssignKeepers() converting a miner/shuttle) or an
   * explicit operator override (`setShipRole()`, e.g. putting the command
   * ship into `keepers` or back). Called during init() so the fleet snaps
   * back to its last known-good state before the first coordinator pass,
   * rather than every manual override reverting itself on every restart.
   */
  private async restorePersistedManualRoles(ships: Ship[]): Promise<void> {
    const rows = (this.tenantId ? await this.store?.getFleetState(this.tenantId) : undefined) ?? [];
    for (const r of rows) {
      if (!MANUAL_ROLES.has(r.role as ManualRole)) continue; // unknown/stale role value; ignore rather than crash
      const role = r.role as ManualRole;
      // Every persisted row is a deliberate role decision — protect it from
      // opportunistic repurposing (autoExplore, promotion) even when assignRole()
      // already derives the same role and the re-apply below is a no-op.
      this.manualRoleShips.add(r.shipSymbol);
      if (this.roleOf(r.shipSymbol) === role) continue; // assignRole() already agrees; nothing to redo
      const ship = ships.find((s) => s.symbol === r.shipSymbol);
      if (!ship) continue; // scrapped while we were down; row is now inert
      if (role === "keeper" && !(r.keeperMarket ?? this.keeperMarketFor(ship))) {
        // Resolve (or fail to) *before* touching any role map: installRoleAgent()
        // itself would throw on this same check, but only after clearRoleMaps()
        // had already torn down whatever assignRole() derived — leaving the ship
        // with no role at all instead of just keeping its derived one.
        this.log(`restore role keeper for ${r.shipSymbol} skipped: no market given, and it isn't currently at one`);
        continue;
      }
      this.clearRoleMaps(r.shipSymbol);
      const market = this.installRoleAgent(ship, role, r.keeperMarket);
      this.log(`restored role ${role} for ${r.shipSymbol}${market ? ` (stationed at ${market})` : ""}`);
    }
  }

  /** Stop and remove a ship's agent from every role map, freeing its route/market claims too. Shared by setShipRole() and restorePersistedManualRoles() — both replace whatever role a ship currently has with a different one. */
  private clearRoleMaps(shipSymbol: string): void {
    this.miners.get(shipSymbol)?.stop();
    this.traders.get(shipSymbol)?.stop();
    this.surveyors.get(shipSymbol)?.stop();
    this.scouts.get(shipSymbol)?.stop();
    this.tours.get(shipSymbol)?.stop();
    this.keepers.get(shipSymbol)?.stop();
    this.siphoners.get(shipSymbol)?.stop();
    this.miners.delete(shipSymbol);
    this.traders.delete(shipSymbol);
    this.surveyors.delete(shipSymbol);
    this.scouts.delete(shipSymbol);
    this.tours.delete(shipSymbol);
    this.keepers.delete(shipSymbol);
    this.siphoners.delete(shipSymbol);
    this.keeperMarkets.delete(shipSymbol);
    this.dispatcher.release(shipSymbol);
    this.idleShips.delete(shipSymbol);
  }

  /**
   * Construct the right agent type for `role` and insert it into that role's
   * map. Returns the resolved keeper market when `role === "keeper"` (for
   * the caller to persist), throws if that role is requested with no
   * market resolvable. Shared by setShipRole() and restorePersistedManualRoles().
   */
  private installRoleAgent(ship: Ship, role: ManualRole, keeperMarket?: string): string | undefined {
    const shipSymbol = ship.symbol;
    switch (role) {
      case "miner":
        this.miners.set(
          shipSymbol,
          new ShipAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${shipSymbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
            deliverCargo: (s) => this.contracts?.deliverVia(s) ?? Promise.resolve(null),
            surveyPool: this.surveyPool,
            protectedGoods: () => this.allProtectedGoods(),
            getCredits: () => this.spendableCredits(),
          }).withWorld(this.positions, this.markets),
        );
        return undefined;
      case "surveyor":
        this.surveyors.set(
          shipSymbol,
          new ShipAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${shipSymbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
            surveyPool: this.surveyPool,
            protectedGoods: () => this.allProtectedGoods(),
            ensureSystemCharted: (sys) => this.chartSystemFor(shipSymbol, sys),
            marketTourTargets: () => this.marketTourTargets(),
            shipyardTourTargets: () => this.shipyardTourTargets(),
            recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
            getCredits: () => this.spendableCredits(),
          }).withWorld(this.positions, this.markets),
        );
        return undefined;
      case "siphoner":
        this.siphoners.set(
          shipSymbol,
          new SiphonerAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${shipSymbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
            protectedGoods: () => this.allProtectedGoods(),
          }).withWorld(this.positions, this.markets),
        );
        return undefined;
      case "keeper": {
        const resolvedKeeperMarket = keeperMarket ?? this.keeperMarketFor(ship);
        if (!resolvedKeeperMarket) throw new Error(`${shipSymbol}: no keeper market given, and it isn't currently at one`);
        this.keepers.set(
          shipSymbol,
          new ShipAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${shipSymbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
            recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
            keeperMarket: () => this.keeperMarkets.get(shipSymbol),
            getCredits: () => this.spendableCredits(),
          }).withWorld(this.positions, this.markets),
        );
        this.keeperMarkets.set(shipSymbol, resolvedKeeperMarket);
        return resolvedKeeperMarket;
      }
      case "tour":
        this.tours.set(
          shipSymbol,
          new ShipAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${shipSymbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
            ensureSystemCharted: (sys) => this.chartSystemFor(shipSymbol, sys),
            marketTourTargets: () => this.sectorTourTargets(shipSymbol),
            staleMarketTargets: () => this.staleMarketTargets(),
            shipyardTourTargets: () => this.shipyardTourTargets(),
            recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
            getCredits: () => this.spendableCredits(),
          }).withWorld(this.positions, this.markets),
        );
        return undefined;
      case "trader":
        this.traders.set(shipSymbol, new TraderAgent(ship, this.traderOptions(shipSymbol)).withWorld(this.positions));
        return undefined;
      case "scout":
        this.registerScout(ship);
        return undefined;
    }
  }

  private registerScout(ship: Ship): void {
    this.scouts.set(
      ship.symbol,
      new ScoutAgent(ship, {
        api: this.api,
        shouldRun: () => !this.paused,
        log: (m) => this.log(`${ship.symbol}: ${m}`),
        recordLedger: this.recordLedger,
        onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
        recordMarket: (wp) => this.recordMarketSnapshot(wp),
        isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
        scanIntervalMin: this.doctrine.value("sensorScanIntervalMin", 0),
        onScan: (res) => this.ingestScanResults(ship.symbol, res),
      })
        .withWorld(this.positions, this.markets)
        .withCharted(this.rawWaypoints.filter((w) => w.chart).map((w) => w.symbol)),
    );
    this.log(`role: scout ${ship.symbol} (chart)`);
  }

  /** Fold sensor-scan results into galaxy knowledge so the map/missions see them. */
  private ingestScanResults(shipSymbol: string, res: { systems?: components["schemas"]["ScannedSystem"][]; waypoints?: components["schemas"]["ScannedWaypoint"][] }): void {
    if (res.systems?.length) {
      const added = this.galaxy.ingestScannedSystems(res.systems);
      this.log(`${shipSymbol}: scan revealed ${added} systems`);
      this.onActivity?.("scan", `${shipSymbol} revealed ${added} systems`);
    }
    if (res.waypoints?.length) {
      const added = this.galaxy.ingestScannedWaypoints(res.waypoints);
      this.log(`${shipSymbol}: scan revealed ${added} waypoints`);
      this.onActivity?.("scan", `${shipSymbol} revealed ${added} waypoints`);
    }
  }

  /** Give the chart scout a sensor array if a shipyard sells one and we can afford it. */
  private async maybeInstallScanner(): Promise<void> {
    if (this.scouts.size === 0) return;
    const scout = [...this.scouts.entries()][0];
    if (!scout) return;
    const ship = scout[1].getShip();
    const mountingPoints = ship.frame?.mountingPoints ?? ship.mounts.length;
    if (ship.mounts.some((m) => m.symbol.startsWith("MOUNT_SENSOR_ARRAY")) || ship.mounts.length >= mountingPoints) return;
    const seller = ((await this.store?.moduleCatalog("MOUNT_SENSOR_ARRAY_I")) ?? []).find((m) => m.symbol === "MOUNT_SENSOR_ARRAY_I");
    if (!seller) return;
    if (this.credits < this.minCashReserve() + seller.purchasePrice) return;
    this.log(`installing MOUNT_SENSOR_ARRAY_I on ${scout[0]} from ${seller.waypointSymbol}`);
    await this.buyAndInstallComponent(scout[0], "MOUNT_SENSOR_ARRAY_I", seller.waypointSymbol);
  }

  /** Scan local shipyards and score available ships by utility per credit. */
  async scanLoadouts(): Promise<ShipScore[]> {
    const agent = await this.api.getMyAgent();
    const allYards = this.galaxy.listSystems().flatMap((sys) =>
      sys.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")).map((w) => ({ ...w, systemSymbol: sys.symbol }))
    );
    const available: { ship: ShipyardShip; yardSymbol: string }[] = [];
    // Prefer the store's recorded inventory (kept fresh by the tour shuttle) so
    // the buy pass doesn't hammer every shipyard API every 2s tick. Only fall
    // back to live scans for yards the store has never seen.
    const recorded = new Map<string, { shipType: string; purchasePrice: number; frameSymbol: string; fuelCapacity: number; cargoCapacity: number; moduleSlots: number; mountingPoints: number }[]>();
    for (const r of (await this.store?.shipyardInventory()) ?? []) {
      const list = recorded.get(r.waypointSymbol) ?? [];
      list.push({
        shipType: r.shipType,
        purchasePrice: r.purchasePrice,
        frameSymbol: r.frameSymbol,
        fuelCapacity: r.fuelCapacity,
        cargoCapacity: r.cargoCapacity,
        moduleSlots: r.moduleSlots,
        mountingPoints: r.mountingPoints,
      });
      recorded.set(r.waypointSymbol, list);
    }
    for (const yard of allYards) {
      const cached = recorded.get(yard.symbol);
      if (cached && cached.length > 0) {
        for (const c of cached) {
          await this.doctrine.ensureShipTypeRule(c.frameSymbol);
          available.push({
            ship: {
              type: c.shipType as ShipType,
              purchasePrice: c.purchasePrice,
              frame: { symbol: c.frameSymbol, fuelCapacity: c.fuelCapacity, moduleSlots: c.moduleSlots, mountingPoints: c.mountingPoints },
              engine: { speed: 0 },
              modules: [],
              mounts: [],
            } as unknown as ShipyardShip,
            yardSymbol: yard.symbol,
          });
        }
        continue;
      }
      try {
        const shipyard = await this.api.getShipyard(yard.systemSymbol, yard.symbol);
        for (const ship of shipyard.ships ?? []) {
          available.push({ ship, yardSymbol: yard.symbol });
          // Register a doctrine cap for every hull the shipyard sells, not just
          // ones we own — so the operator can tune the cap before the first buy.
          await this.doctrine.ensureShipTypeRule(ship.frame.symbol);
        }
      } catch (err) {
        // shipyard may be unreachable; ignore
      }
    }
    return scoreShips(available, agent.credits - this.minCashReserve());
  }

  /** Purchase a specific ship type at a specific shipyard. */
  async buyShip(type: ShipType, yardSymbol: string): Promise<Ship> {
    const agent = await this.api.getMyAgent();
    const yardSystem = yardSymbol.slice(0, yardSymbol.lastIndexOf("-"));
    const shipyard = await this.api.getShipyard(yardSystem, yardSymbol);
    const offer = shipyard.ships?.find((s) => s.type === type);
    if (!offer) throw new Error(`${type} not available at ${yardSymbol}`);
    if (!this.canAfford(offer.purchasePrice, agent.credits)) {
      throw new Error(`need ${offer.purchasePrice + this.minCashReserve()}c, have ${agent.credits}c`);
    }
    this.log(`purchasing ${type} at ${yardSymbol} for ${offer.purchasePrice} credits`);
    const res = await this.api.purchaseShip(type, yardSymbol);
    await this.doctrine.ensureShipTypeRule(type);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: res.ship.symbol,
      waypointSymbol: yardSymbol,
      type: "SHIP",
      tradeSymbol: type,
      total: res.transaction.price,
    });
    await this.discord?.postActivity({
      timestamp: new Date().toISOString(),
      shipSymbol: "fleet",
      kind: "ship",
      detail: `purchased ship ${res.ship.symbol} (${type}) at ${yardSymbol} for ${res.transaction.price}c`,
      credits: -res.transaction.price,
    });
    await this.assignRole(res.ship);
    return res.ship;
  }

  /** True if there are any waypoints we know of (loaded systems) that are uncharted. */
  private hasUnchartedWork(): boolean {
    for (const sys of this.galaxy.listSystems()) {
      for (const w of sys.waypoints) {
        if (!w.chart) return true;
      }
    }
    return false;
  }

  /** True if the scout can actually reach uncharted work: same system, or a jump gate that is complete. */
  private async scoutCanReachUncharted(): Promise<boolean> {
    for (const sys of this.galaxy.listSystems()) {
      const uncharted = sys.waypoints.some((w) => !w.chart);
      if (!uncharted) continue;
      if (sys.symbol === this.systemSymbol) return true;
      for (const gate of this.galaxy.gatesTo(this.systemSymbol, sys.symbol)) {
        if (await this.galaxy.refreshGateConstruction(this.systemSymbol, gate)) return true;
      }
    }
    return false;
  }

  /**
   * Buy a chart scout (cheap surveyor hull, 80 fuel) when there is actually
   * uncharted work to do and we can afford it. No uncharted waypoints in any
   * known system → no purchase (avoids buying a ship that would sit idle).
   */
  async maybeBuyScout(): Promise<void> {
    if (this.scouts.size > 0) return;
    const scanWanted = this.doctrine.value("sensorScanIntervalMin", 0) > 0;
    if (!scanWanted) {
      if (!this.hasUnchartedWork()) return;
      if (!(await this.scoutCanReachUncharted())) return;
    }
    const agent = await this.api.getMyAgent();
    if (agent.credits < this.minCashReserve() + 35_000) return;

    const yards = this.rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"));
    for (const yard of yards) {
      try {
        const shipyard = await this.api.getShipyard(this.systemSymbol, yard.symbol);
        const available = shipyard.ships?.find((s) => s.type === "SHIP_SURVEYOR");
        if (!available) {
          this.log(`scout: no SHIP_SURVEYOR at ${yard.symbol} (stock: ${shipyard.ships?.map((s) => s.type).join(", ") ?? "none"})`);
          continue;
        }
        // Respect the per-hull doctrine cap: a surveyor scout is a FRAME_DRONE,
        // so it must not slip past the drone cap the operator set.
        if (this.doctrine.value(`shipCap:${available.frame.symbol}`, Infinity) <= this.droneCount()) return;
        if (!this.canAfford(available.purchasePrice, agent.credits)) return;
        this.log(`purchasing SHIP_SURVEYOR scout at ${yard.symbol} for ${available.purchasePrice} credits`);
        const res = await this.api.purchaseShip("SHIP_SURVEYOR", yard.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: res.ship.symbol,
          waypointSymbol: yard.symbol,
          type: "SHIP",
          tradeSymbol: "SHIP_SURVEYOR",
          total: res.transaction.price,
        });
        await this.discord?.postActivity({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          kind: "ship",
          detail: `purchased scout ship ${res.ship.symbol} (SHIP_SURVEYOR) at ${yard.symbol} for ${res.transaction.price}c`,
          credits: -res.transaction.price,
        });
        await this.registerScout(res.ship);
        return;
      } catch (err) {
        this.log(`scout shipyard ${yard.symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Buy a SHIP_SIPHON_DRONE when the siphonTarget doctrine wants one and we
   * don't have one yet. Deliberately ignores the FRAME_DRONE cap — the drone
   * cap exists to stop mining-drone spending; the siphoner is governed by its
   * own hull-specific cap (`shipCap:SHIP_SIPHON_DRONE`) so turning the drone
   * cap to 0 doesn't silently kill the gas-income role.
   */
  async maybeBuySiphoner(): Promise<void> {
    if (this.siphoners.size > 0) return;
    if (this.doctrine.value("siphonTarget", 0) <= 0) return;
    const agent = await this.api.getMyAgent();
    if (agent.credits < this.minCashReserve() + 35_000) return;

    const yards = this.rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"));
    for (const yard of yards) {
      try {
        const shipyard = await this.api.getShipyard(this.systemSymbol, yard.symbol);
        const available = shipyard.ships?.find((s) => s.type === "SHIP_SIPHON_DRONE");
        if (!available) {
          this.log(`siphon: no SHIP_SIPHON_DRONE at ${yard.symbol} (stock: ${shipyard.ships?.map((s) => s.type).join(", ") ?? "none"})`);
          continue;
        }
        await this.doctrine.ensureShipTypeRule("SHIP_SIPHON_DRONE");
        if (this.doctrine.value(`shipCap:SHIP_SIPHON_DRONE`, Infinity) <= this.siphoners.size) return;
        if (!this.canAfford(available.purchasePrice, agent.credits)) return;
        this.log(`purchasing SHIP_SIPHON_DRONE at ${yard.symbol} for ${available.purchasePrice} credits`);
        const res = await this.api.purchaseShip("SHIP_SIPHON_DRONE", yard.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: res.ship.symbol,
          waypointSymbol: yard.symbol,
          type: "SHIP",
          tradeSymbol: "SHIP_SIPHON_DRONE",
          total: res.transaction.price,
        });
        await this.discord?.postActivity({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          kind: "ship",
          detail: `purchased siphon drone ${res.ship.symbol} (SHIP_SIPHON_DRONE) at ${yard.symbol} for ${res.transaction.price}c`,
          credits: -res.transaction.price,
        });
        await this.assignRole(res.ship);
        return;
      } catch (err) {
        this.log(`siphon shipyard ${yard.symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Purchase the highest-scored affordable ship, if any. */
  async maybeBuyShip(): Promise<void> {
    const agent = await this.api.getMyAgent();
    if (agent.credits < this.minCashReserve() + this.shipBudget()) return;

    const yards = this.rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"));
    if (yards.length === 0) return;

    // Count current hulls so per-type doctrine caps can stop the auto-buyer.
    const hullCounts = this.hullCounts();
    const atCap = (frameSymbol: string): boolean => {
      const cap = this.doctrine.value(`shipCap:${frameSymbol}`, Infinity);
      return (hullCounts.get(frameSymbol) ?? 0) >= cap;
    };

    // Priority: buy a Light Shuttle for the market/shipyard tour role first (keeps
    // intel fresh), then grow mining throughput, then the best-scored ship for the
    // fleet's biggest gap. Scoring (not a hardcoded ladder) lets the fleet graduate
    // to bigger hulls as credits grow instead of buying Light Haulers forever.
    let type: ShipType | undefined;
    if (this.tours.size === 0) {
      type = "SHIP_LIGHT_SHUTTLE";
    } else if (this.miners.size < this.doctrine.value("minerTarget", 0)) {
      type = "SHIP_MINING_DRONE";
    }

    // Try the priority type first, then fall through the scored candidates in
    // order. Shipyard stock rotates, so a purchase can fail even when the last
    // snapshot said the hull was available — keep trying the next best pick
    // instead of aborting the whole buy pass.
    const attempts: { type: ShipType; yardSymbol: string; price: number; frameSymbol: string; reason: string }[] = [];

    if (type) {
      for (const yard of yards) {
        try {
          const shipyard = await this.api.getShipyard(this.systemSymbol, yard.symbol);
          const available = shipyard.ships?.find((s) => s.type === type);
          if (available) {
            attempts.push({ type, yardSymbol: yard.symbol, price: available.purchasePrice, frameSymbol: available.frame.symbol, reason: "priority" });
            break;
          }
        } catch (err) {
          this.log(`shipyard ${yard.symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (attempts.length === 0) {
      // No shuttle/miner gap to fill: buy the best-scored ship we can afford.
      // Prefer traders (the fleet's money printer) but take a strong miner if the
      // scoring says it's the best value and we're still under the miner target.
      const scored = await this.scanLoadouts();
      const wantMiner = this.miners.size < this.doctrine.value("minerTarget", 0);
      const picks = scored.filter((s) => (wantMiner ? s.role === "miner" : s.role === "trader"));
      for (const pick of picks.length > 0 ? picks : scored) {
        attempts.push({ type: pick.type as ShipType, yardSymbol: pick.yardSymbol, price: pick.purchasePrice, frameSymbol: pick.frameSymbol, reason: `score ${pick.score}, ${pick.reason}` });
      }
    }

    for (const attempt of attempts) {
      if (atCap(attempt.frameSymbol)) continue;
      if (!this.canAfford(attempt.price, agent.credits)) continue;
      try {
        this.log(`purchasing ${attempt.type} at ${attempt.yardSymbol} for ${attempt.price} credits (${attempt.reason})`);
        const res = await this.api.purchaseShip(attempt.type, attempt.yardSymbol);
        await this.doctrine.ensureShipTypeRule(attempt.type);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: res.ship.symbol,
          waypointSymbol: attempt.yardSymbol,
          type: "SHIP",
          tradeSymbol: attempt.type,
          total: res.transaction.price,
        });
        await this.discord?.postActivity({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          kind: "ship",
          detail: `purchased ship ${res.ship.symbol} (${attempt.type}) at ${attempt.yardSymbol} for ${res.transaction.price}c`,
          credits: -res.transaction.price,
        });
        await this.assignRole(res.ship);
        return;
      } catch (err) {
        // Stock rotated or the yard is unreachable — try the next candidate.
        this.log(`purchase of ${attempt.type} at ${attempt.yardSymbol} failed (${err instanceof Error ? err.message : String(err)}); trying next pick`);
      }
    }
  }

  /** Jump a ship to a connected waypoint in another system. */
  async jumpShip(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const sourceSystem = ship.nav.systemSymbol;
    const targetSystem = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (sourceSystem === targetSystem) {
      throw new Error(`${waypointSymbol} is in the same system; use dispatch instead`);
    }
    const gates = this.galaxy.gatesTo(sourceSystem, targetSystem);
    if (gates.length === 0) {
      await this.galaxy.scanJumpGates(sourceSystem);
    }
    const gate = this.galaxy.gatesTo(sourceSystem, targetSystem)[0];
    if (!gate) throw new Error(`no jump gate from ${sourceSystem} to ${targetSystem}`);
    if (ship.nav.waypointSymbol !== gate || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, gate);
      await this.api.orbitShip(shipSymbol);
    }
    this.log(`${shipSymbol} jumping ${gate} -> ${waypointSymbol}`);
    const res = await this.api.jumpShip(shipSymbol, waypointSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "REFUEL",
      units: 0,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("jump", `${shipSymbol} jumped to ${waypointSymbol}`, -res.transaction.totalPrice);
    // Same learned-cost feed as TraderAgent.jumpToSystem() — a scout/manual
    // jump through this gate is just as real a data point as a trade one.
    this.galaxy.recordJumpCost(gate, targetSystem, res.transaction.totalPrice);
    await this.surveySystem(targetSystem);
  }

  /** Send an idle/explorer ship to scout a connected system. */
  async exploreSystem(shipSymbol: string, targetSystem?: string): Promise<string> {
    // jumpShip() below reaches the home gate via dispatchShip(), which (for a
    // same-system move) delegates to agent.dispatchTo() — documented there as
    // parking the ship and leaving it manual "until released". Nothing used
    // to release it again once the trip here was done, win or lose, so every
    // explore attempt permanently benched the scout it used: autoExplore()'s
    // idle filter excludes any manual ship, so a scout left this way never
    // gets picked again. The try/finally makes release unconditional — a
    // no-op if dispatchTo() was never reached (e.g. the ship was already at
    // the gate, or an error fired before jumpShip() was even called).
    try {
      const ship = await this.api.getShip(shipSymbol);
      const currentSystem = ship.nav.systemSymbol;
      const connected = this.galaxy.connectedSystems(currentSystem);
      const target = targetSystem ?? connected[0];
      if (!target) throw new Error(`no connected systems known from ${currentSystem}`);
      await this.galaxy.loadSystem(target);
      const gates = this.galaxy.gatesTo(currentSystem, target);
      const gate = gates[0];
      if (!gate) throw new Error(`no jump gate to ${target}`);
      const remoteGate = this.galaxy.getSystem(target)!.waypoints.find((w) => w.type === "JUMP_GATE");
      if (!remoteGate) throw new Error(`${target} has no jump gate waypoint`);

      // A gate that is still under construction cannot be jumped through — no point
      // burning fuel to reach it. Skip these systems until the gate is completed.
      // Checked (and cached) via GalaxyAtlas so this agrees with every other
      // gate-aware decision — canJump()'s own comment has the reasoning.
      if (!(await this.galaxy.refreshGateConstruction(currentSystem, gate))) {
        // Re-fetch just for the materials detail in the error message — rare
        // path (only reached when the gate genuinely isn't complete yet), so
        // the extra call is cheap. A second, unrelated fetch failure here
        // falls through and lets the jump attempt itself surface the error.
        try {
          const constr = await this.api.getConstruction(currentSystem, gate);
          if (!constr.isComplete) {
            throw new Error(`gate ${gate} is under construction (${constr.materials.map((m) => `${m.tradeSymbol} ${m.fulfilled}/${m.required}`).join(", ")})`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("under construction")) throw err;
        }
      }

      await this.jumpShip(shipSymbol, remoteGate.symbol);
      await this.surveySystem(target);
      // surveySystem()'s own surveyMarkets() call sweeps every MARKETPLACE
      // waypoint in `target` via a remote getMarket() call — but confirmed
      // live, that only returns real tradeGoods for a waypoint the ship is
      // actually standing at (the gate, right after this jump); every other
      // market in the system comes back empty, since SpaceTraders only
      // reveals live prices to a ship physically present. Two consecutive
      // trips to X1-TV75/X1-ZU53/etc. left each with exactly one good on
      // record — the gate's own antimatter listing — with the system's
      // other markets never actually seen. Physically tour a few of them
      // before this scout is released back to its normal duty, so a system
      // gets more than a single accidental price point out of being
      // "explored" at all.
      // Root-caused live: the first attempt at this rejected every one of
      // these stops with a huge, seemingly-nonsensical "requires N more
      // fuel" error, even for waypoints a few hundred units from the gate.
      // ShipAgent/ScoutAgent's own estimatedFuelTo() silently returns 0 for
      // any waypoint missing from that ship's waypointPositions map — and
      // that map is seeded once, via withWorld(), at the moment the agent
      // object was constructed, then never refreshed again for the rest of
      // that ship's lifetime. A long-lived scout's agent predates every
      // system discovered mid-session, so every newly-reached system's
      // waypoints read as "0 fuel away" to it — CRUISE gets picked as if
      // the leg were free, and the real navigateShip() call (which has no
      // knowledge of our cache and computes the actual distance) rejects it
      // with the true, large shortfall. surveySystem() just above already
      // refreshed this.positions with target's real coordinates; push that
      // into this specific scout's own cache before asking it to fly
      // anywhere in the system it just arrived in.
      const scoutAgent = this.tours.get(shipSymbol) ?? this.scouts.get(shipSymbol);
      scoutAgent?.withWorld(this.positions, this.markets);
      const MAX_EXTRA_MARKET_STOPS = 3;
      const otherMarkets = (this.galaxy.getSystem(target)?.waypoints ?? [])
        .filter((w) => w.symbol !== remoteGate.symbol && w.traits.some((t) => t.symbol === "MARKETPLACE"))
        .slice(0, MAX_EXTRA_MARKET_STOPS);
      for (const wp of otherMarkets) {
        try {
          await this.dispatchShip(shipSymbol, wp.symbol);
          await this.recordMarketSnapshot(wp.symbol);
        } catch (err) {
          this.log(`market tour of ${wp.symbol} in ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.log(`${shipSymbol} explored ${target}`);
      return target;
    } finally {
      this.controlledAgent(shipSymbol)?.release();
    }
  }

  /** Manually refuel a ship (docks first if needed). */
  async refuelShip(shipSymbol: string): Promise<{ fuel: number; capacity: number; cost: number }> {
    const ship = await this.api.getShip(shipSymbol);
    if (ship.nav.status === "IN_TRANSIT") throw new Error(`${shipSymbol} is in transit`);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.refuelShip(shipSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: ship.nav.waypointSymbol,
      type: "REFUEL",
      units: res.fuel.current,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("refuel", `${shipSymbol} refueled to ${res.fuel.current}/${res.fuel.capacity}`, -res.transaction.totalPrice);
    return { fuel: res.fuel.current, capacity: res.fuel.capacity, cost: res.transaction.totalPrice };
  }

  /** Scrap a ship at a shipyard, removing it from the fleet and returning credits. */
  async scrapShip(shipSymbol: string): Promise<{ transaction: components["schemas"]["ScrapTransaction"] }> {
    const ship = await this.api.getShip(shipSymbol);
    if (ship.nav.status === "IN_TRANSIT") throw new Error(`${shipSymbol} is in transit`);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.scrapShip(shipSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: ship.nav.waypointSymbol,
      type: "SHIP",
      tradeSymbol: "SCRAP",
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("scrap", `${shipSymbol} scrapped at ${ship.nav.waypointSymbol} for ${res.transaction.totalPrice}c`, res.transaction.totalPrice);
    await this.removeShip(shipSymbol);
    return { transaction: res.transaction };
  }

  /** Remove a ship from all role maps (after scrapping). */
  private async removeShip(shipSymbol: string): Promise<void> {
    this.miners.get(shipSymbol)?.stop();
    this.traders.get(shipSymbol)?.stop();
    this.surveyors.get(shipSymbol)?.stop();
    this.scouts.get(shipSymbol)?.stop();
    this.tours.get(shipSymbol)?.stop();
    this.keepers.get(shipSymbol)?.stop();
    this.siphoners.get(shipSymbol)?.stop();
    this.miners.delete(shipSymbol);
    this.traders.delete(shipSymbol);
    // Free the route claim, or the good stays reserved for a ship that's gone.
    this.dispatcher.release(shipSymbol);
    this.surveyors.delete(shipSymbol);
    this.scouts.delete(shipSymbol);
    this.tours.delete(shipSymbol);
    this.keepers.delete(shipSymbol);
    this.siphoners.delete(shipSymbol);
    // Free the market too, or maybeAssignKeepers sees it as still covered and
    // never stations a replacement — the market just goes stale forever.
    this.keeperMarkets.delete(shipSymbol);
    if (this.tenantId) await this.store?.removeFleetState(this.tenantId, shipSymbol);
    this.idleShips.delete(shipSymbol);
    // A scrapped warehouse ship leaves nothing for buy/sell-role traders to
    // rendezvous with — clear the designation rather than pointing at a hull
    // that no longer exists.
    if (this.warehouseShip?.shipSymbol === shipSymbol) {
      this.warehouseShip = undefined;
      if (this.tenantId) await this.store?.removeFleetFlag(this.tenantId, "warehouseShip");
    }
    // Drop any persisted hold/mine-pin and manual dispatch override too, or a
    // scrapped ship's ghost assignment would come back on the next restart.
    await this.updateShipManualState(shipSymbol, { holdWaypoint: null, minePin: null });
    await this.setManualDispatch(shipSymbol, undefined);
  }

  /**
   * Operator override: force a ship into a specific role, regardless of what
   * assignRole() would have derived from its mounts/frame. Exists for cases
   * assignRole() deliberately can't reach on its own — most notably the
   * command ship, which assignRole() will never route to `keepers` (only a
   * SATELLITE/FRAME_PROBE hull qualifies) and `maybeAssignKeepers()` now
   * explicitly excludes (see the idle-candidate filter's COMMAND check) —
   * but works for any ship symbol, not just the flagship.
   *
   * `keeperMarket` is required when `role === "keeper"` unless the ship is
   * already sitting at a market waypoint (keeperMarketFor() only resolves
   * from the ship's *current* position, unlike the real keeperLoop()/
   * nextKeeperTask() poll, which flies to its assigned market on its own).
   *
   * Survives a restart: restorePersistedManualRoles(), called from init(),
   * re-applies whatever role is persisted here for any ship symbol whose
   * derived role (from assignRole()) disagrees with it.
   */
  async setShipRole(shipSymbol: string, role: ManualRole, keeperMarket?: string): Promise<void> {
    // clearRoleMaps() below stops the current agent and drops it; installRoleAgent()
    // then constructs a brand-new one, which starts with suspended=false —
    // silently discarding a live suspension instead of ever resolving it. A
    // suspended ship is mid-flight under a mission or rescue tender's direct
    // (non-agent) API calls; swapping its agent out from under that reintroduces
    // exactly the "not currently docked" race suspend() exists to prevent (see
    // ShipAgent.suspend()'s own doc comment). Refuse instead of guessing how to
    // transplant state across what can be a totally different agent class
    // (e.g. miner -> trader).
    if (this.controlledAgent(shipSymbol)?.isSuspended()) {
      throw new Error(`${shipSymbol} is suspended (mission or rescue in progress) — can't change its role until that finishes`);
    }
    const ship = this.shipFor(shipSymbol) ?? (await this.api.getShip(shipSymbol));
    // The persisted `shipManualState.holdWaypoint` flag (set by holdShip(),
    // cleared by releaseShip()/releaseTo()) lives independently of role
    // assignment. Reassigning a ship's role here — the freshly-installed
    // agent starts unheld (isManual()=false) — did not used to clear it, so
    // it survived invisibly until the next process restart, at which point
    // init()'s restore loop replayed holdShip() from the stale flag and put
    // the ship right back into "manual hold", silently overriding the role
    // just assigned. On Render this bites every idle spin-down/cold-start
    // cycle, not just deploys, which is what made two tour ships look like
    // they kept re-holding themselves with no operator action. An explicit
    // role assignment is itself an explicit operator decision and must
    // supersede a stale hold, same as releaseTo() clearing it on handback.
    await this.updateShipManualState(shipSymbol, { holdWaypoint: null });
    this.clearRoleMaps(shipSymbol);
    const resolvedKeeperMarket = this.installRoleAgent(ship, role, keeperMarket);
    this.manualRoleShips.add(shipSymbol);
    this.log(`role: ${role} ${shipSymbol} (manual override)`);

    // Temporary diagnostic: bracketing the persist call so we can see in
    // the logs whether it hangs, throws (should already surface via the
    // dashboard route's catch, but confirming here removes the doubt), or
    // completes — see pool.ts's withTenant() for the matching instrumentation.
    if (this.tenantId) {
      this.log(`${shipSymbol}: persisting role ${role}...`);
      await this.store?.setFleetState(this.tenantId, shipSymbol, role, resolvedKeeperMarket);
      this.log(`${shipSymbol}: persisted role ${role}`);
    }

    if (this.running) {
      if (this.scheduler) {
        // shipSymbol is likely already in scheduledShips from its old role
        // (its old agent's task chain just terminated itself via stop()
        // setting running=false), so syncSchedulerTasks()'s generic "is this
        // ship new" check would skip it — enqueue the new agent's first task
        // directly instead, same as maybeAssignKeepers()'s scheduler branch.
        const scheduler = this.scheduler;
        const before = scheduler.size();
        switch (role) {
          case "miner": { const a = this.miners.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextTask()); break; }
          case "trader": { const a = this.traders.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextTask()); break; }
          case "surveyor": { const a = this.surveyors.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextSurveyTask()); break; }
          case "tour": { const a = this.tours.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextTourTask()); break; }
          case "keeper": { const a = this.keepers.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextKeeperTask()); break; }
          case "scout": { const a = this.scouts.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextTask()); break; }
          case "siphoner": { const a = this.siphoners.get(shipSymbol)!; a.running = true; scheduler.enqueue(a.nextTask()); break; }
        }
        this.scheduledShips.add(shipSymbol);
        this.log(`${shipSymbol}: enqueued ${role} task (scheduler size ${before} -> ${scheduler.size()})`);
      } else {
        void this.traders.get(shipSymbol)?.runLoop(1_000_000);
        void this.miners.get(shipSymbol)?.runLoop(1_000_000);
        void this.surveyors.get(shipSymbol)?.surveyLoop(1_000_000);
        void this.tours.get(shipSymbol)?.tourLoop(1_000_000);
        void this.scouts.get(shipSymbol)?.runLoop(1_000_000);
        void this.siphoners.get(shipSymbol)?.runLoop(1_000_000);
        void this.keepers.get(shipSymbol)?.keeperLoop(1_000_000);
      }
    }
  }

  /** Verify a ship is at a market before trading. */
  private async ensureShipAtMarket(shipSymbol: string): Promise<{ ship: Ship; systemSymbol: string; waypointSymbol: string }> {
    const ship = await this.api.getShip(shipSymbol);
    if (ship.nav.status === "IN_TRANSIT") throw new Error(`${shipSymbol} is in transit — wait for arrival`);
    const waypointSymbol = ship.nav.waypointSymbol;
    const systemSymbol = ship.nav.systemSymbol;
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    const waypoint = known?.waypoints.find((w) => w.symbol === waypointSymbol);
    if (!waypoint || !waypoint.traits.some((t) => t.symbol === "MARKETPLACE")) {
      throw new Error(`${waypointSymbol} is not a marketplace`);
    }
    return { ship, systemSymbol, waypointSymbol };
  }

  /** Buy cargo for a ship at its current market. */
  async buyCargo(shipSymbol: string, good: string, units: number): Promise<void> {
    const { ship, systemSymbol, waypointSymbol } = await this.ensureShipAtMarket(shipSymbol);
    const market = await this.api.getMarket(systemSymbol, waypointSymbol);
    const listing = market.tradeGoods?.find((g) => g.symbol === good);
    // FUEL is exempt from the cash floor everywhere in the fleet — see
    // canAfford()'s own comment. A stranded ship's recovery cost matters more
    // than the reserve.
    if (listing && good !== "FUEL") {
      const agent = await this.api.getMyAgent();
      if (!this.canAfford(listing.purchasePrice * units, agent.credits)) {
        throw new Error(`${units}u ${good} costs ~${listing.purchasePrice * units}c, only ${agent.credits - this.minCashReserve()}c available above the cash floor`);
      }
    }
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.purchaseCargo(shipSymbol, good, units);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: good,
      units,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("buy", `${shipSymbol} bought ${units}u ${good} @ ${res.transaction.pricePerUnit}c`, -res.transaction.totalPrice);
  }

  /** Sell cargo for a ship at its current market. */
  async sellCargo(shipSymbol: string, good: string, units: number): Promise<void> {
    const { ship, waypointSymbol } = await this.ensureShipAtMarket(shipSymbol);
    const held = ship.cargo.inventory?.find((i) => i.symbol === good);
    if (!held || held.units <= 0) {
      throw new Error(`${shipSymbol} has no ${good} in cargo`);
    }
    const toSell = Math.min(units, held.units);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.sellCargo(shipSymbol, good, toSell);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "SELL",
      tradeSymbol: good,
      units: toSell,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("sell", `${shipSymbol} sold ${toSell}u ${good} @ ${res.transaction.pricePerUnit}c`, res.transaction.totalPrice);
  }

  /** Dump cargo overboard — no market or dock required, unlike buy/sell. For an operator clearing out dead stock manually; nothing pays for this. */
  async jettisonCargo(shipSymbol: string, good: string, units: number): Promise<void> {
    const ship = this.shipFor(shipSymbol) ?? (await this.api.getShip(shipSymbol));
    const held = ship.cargo.inventory?.find((i) => i.symbol === good);
    if (!held || held.units <= 0) throw new Error(`${shipSymbol} has no ${good} in cargo`);
    const toJettison = Math.min(units, held.units);
    await this.api.jettisonCargo(shipSymbol, good, toJettison);
    this.log(`${shipSymbol} jettisoned ${toJettison}u ${good}`);
    this.onActivity?.("jettison", `${shipSymbol} jettisoned ${toJettison}u ${good}`, undefined, shipSymbol);
  }

  /** Worst (lowest) condition across frame/engine/reactor — the "how banged up is this ship" number the repair floor is measured against. */
  private worstCondition(ship: Ship): number {
    return Math.min(ship.frame?.condition ?? 1, ship.engine?.condition ?? 1, ship.reactor?.condition ?? 1);
  }

  private async isShipyard(systemSymbol: string, waypointSymbol: string): Promise<boolean> {
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    return known?.waypoints.find((w) => w.symbol === waypointSymbol)?.traits.some((t) => t.symbol === "SHIPYARD") ?? false;
  }

  /** Repair a ship to full condition. Must be DOCKED at a shipyard-trait waypoint — the same requirement the raw API itself enforces, checked here first so the error is legible instead of a raw 400. */
  async repairShip(shipSymbol: string): Promise<void> {
    const ship = this.shipFor(shipSymbol) ?? (await this.api.getShip(shipSymbol));
    const waypointSymbol = ship.nav.waypointSymbol;
    if (ship.nav.status !== "DOCKED" || !(await this.isShipyard(ship.nav.systemSymbol, waypointSymbol))) {
      throw new Error(`${shipSymbol} must be docked at a shipyard to repair (currently ${ship.nav.status} at ${waypointSymbol})`);
    }
    const preview = await this.api.getRepairCost(shipSymbol);
    const agent = await this.api.getMyAgent();
    if (!this.canAfford(preview.transaction.totalPrice, agent.credits)) {
      throw new Error(`repair needs ${preview.transaction.totalPrice}c, only ${agent.credits - this.minCashReserve()}c available above the cash floor`);
    }
    const res = await this.api.repairShip(shipSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "SHIP",
      total: -res.transaction.totalPrice,
    });
    this.log(`${shipSymbol} repaired at ${waypointSymbol} for ${res.transaction.totalPrice}c`);
    this.onActivity?.("repair", `${shipSymbol} repaired at ${waypointSymbol} for ${res.transaction.totalPrice}c`, -res.transaction.totalPrice, shipSymbol);
  }

  /** Install a module/mount from a ship's cargo at the nearest shipyard. */
  async installComponent(shipSymbol: string, componentSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const systemSymbol = ship.nav.systemSymbol;
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    const yards = known?.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")) ?? [];
    if (yards.length === 0) throw new Error(`no shipyard in ${systemSymbol}`);

    const held = ship.cargo.inventory?.find((i) => i.symbol === componentSymbol);
    if (!held || held.units <= 0) throw new Error(`${shipSymbol} has no ${componentSymbol} in cargo`);

    // Fly to the nearest shipyard and dock.
    const yard = yards[0]!;
    if (ship.nav.waypointSymbol !== yard.symbol || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, yard.symbol);
    }
    const docked = await this.api.getShip(shipSymbol);
    if (docked.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);

    const isMount = componentSymbol.startsWith("MOUNT_");
    const res = isMount
      ? await this.api.installMount(shipSymbol, componentSymbol)
      : await this.api.installModule(shipSymbol, componentSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: yard.symbol,
      type: "SHIP",
      tradeSymbol: componentSymbol,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("install", `${shipSymbol} installed ${componentSymbol} at ${yard.symbol}`, -res.transaction.totalPrice);
    this.log(`installed ${componentSymbol} on ${shipSymbol} at ${yard.symbol}`);
  }

  /** Remove a module/mount from a ship at the nearest shipyard (goes back to cargo). */
  async removeComponent(shipSymbol: string, componentSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const systemSymbol = ship.nav.systemSymbol;
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    const yards = known?.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")) ?? [];
    if (yards.length === 0) throw new Error(`no shipyard in ${systemSymbol}`);

    const yard = yards[0]!;
    if (ship.nav.waypointSymbol !== yard.symbol || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, yard.symbol);
    }
    const docked = await this.api.getShip(shipSymbol);
    if (docked.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);

    const isMount = componentSymbol.startsWith("MOUNT_");
    const res = isMount
      ? await this.api.removeMount(shipSymbol, componentSymbol)
      : await this.api.removeModule(shipSymbol, componentSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: yard.symbol,
      type: "SHIP",
      tradeSymbol: componentSymbol,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("install", `${shipSymbol} removed ${componentSymbol} at ${yard.symbol}`, -res.transaction.totalPrice);
    this.log(`removed ${componentSymbol} from ${shipSymbol} at ${yard.symbol}`);
  }

  /** Buy a module/mount from a market and install it on a ship (flies there if needed). */
  async buyAndInstallComponent(shipSymbol: string, componentSymbol: string, marketWaypoint: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const systemSymbol = ship.nav.systemSymbol;
    const targetSystem = marketWaypoint.slice(0, marketWaypoint.lastIndexOf("-"));
    if (ship.nav.systemSymbol !== targetSystem) {
      await this.jumpShip(shipSymbol, marketWaypoint);
    } else if (ship.nav.waypointSymbol !== marketWaypoint || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, marketWaypoint);
    }
    const atMarket = await this.api.getShip(shipSymbol);
    if (atMarket.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const market = await this.api.getMarket(systemSymbol, marketWaypoint);
    const listing = market.tradeGoods?.find((g) => g.symbol === componentSymbol);
    const agent = await this.api.getMyAgent();
    if (listing && !this.canAfford(listing.purchasePrice, agent.credits)) {
      throw new Error(`${componentSymbol} costs ${listing.purchasePrice}c, only ${agent.credits - this.minCashReserve()}c available above the cash floor`);
    }
    const res = await this.api.purchaseCargo(shipSymbol, componentSymbol, 1);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: marketWaypoint,
      type: "PURCHASE",
      tradeSymbol: componentSymbol,
      units: 1,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("buy", `${shipSymbol} bought ${componentSymbol} @ ${res.transaction.pricePerUnit}c`, -res.transaction.totalPrice);
    await this.installComponent(shipSymbol, componentSymbol);
  }

  /** Pick an idle cargo-capable ship to run a mission, preferring the largest hold. */
  private async pickMissionCarrier(exclude: Set<string>, targetWaypoint?: string): Promise<string | undefined> {
    // One shared availability check (docs/ship-control-state-audit.md, Phase
    // 1) replaces the old pair here: availableFor("mission") already means
    // "not held by an operator, and not manual/suspended" (mission outranks
    // warehouse/keeper/auto, so a ship claimed by any of those is still
    // available to a mission; only operator beats it) — same result as the
    // old notBusy() + notClaimedAgainstMission() combination, minus the
    // duplicate logic.
    const available = this.availableFor("mission");
    const candidates: { sym: string; cargo: number; fuelCap: number }[] = [];
    for (const [s, a] of this.miners) if (!exclude.has(s) && available.has(s)) candidates.push({ sym: s, cargo: a.getShip().cargo.capacity, fuelCap: a.getShip().fuel.capacity });
    for (const [s, a] of this.traders) if (!exclude.has(s) && available.has(s)) candidates.push({ sym: s, cargo: a.getShip().cargo.capacity, fuelCap: a.getShip().fuel.capacity });
    // A carrier must be able to reach the target on a full tank (it can refuel at
    // markets along the way, but never beyond its tank). Skip ships that can't —
    // otherwise the mission loops on "cannot navigate" forever.
    let reachable = candidates;
    if (targetWaypoint) {
      reachable = [];
      for (const c of candidates) {
        const ship = this.cachedShip(c.sym);
        if (!ship) continue;
        if (ship.fuel.capacity <= 0) continue;
        if (await this.canReachTarget(c.sym, targetWaypoint)) reachable.push(c);
      }
    }
    // Tiebreak on fuel capacity (more margin over what the trip needs), not
    // ship symbol: confirmed live, an alphabetical tiebreak among several
    // reachable ships tied on cargo picked the one with the thinnest
    // possible fuel margin (barely enough to reach the target on paper)
    // purely because its symbol sorted first — a single normal fuel/position
    // fluctuation before the next mission tick was then enough to flip
    // stepCarrier()'s own reachability check to "unreachable" and release
    // the carrier. Preferring fuel capacity leaves headroom against exactly
    // that.
    reachable.sort((a, b) => b.cargo - a.cargo || b.fuelCap - a.fuelCap || a.sym.localeCompare(b.sym));
    const picked = reachable[0]?.sym;
    if (picked) this.shipRegistry.claim(picked, "mission", this.roleOf(picked));
    return picked;
  }
  /** Known fuel stops (marketplaces that list FUEL) in a system, by symbol. */
  private async fuelStops(systemSymbol: string): Promise<Set<string>> {
    const out = new Set<string>();
    const rows = (await this.store?.latestMarketSnapshots())?.filter((r) => r.systemSymbol === systemSymbol && r.goodSymbol === "FUEL" && r.purchasePrice > 0) ?? [];
    for (const r of rows) {
      out.add(r.waypointSymbol);
    }
    const known = this.galaxy.getSystem(systemSymbol);
    for (const w of known?.waypoints ?? []) {
      if (w.type === "FUEL_STATION") out.add(w.symbol);
    }
    return out;
  }

  /** Marketplace waypoints to tour periodically so snapshots stay fresh. */
  private async marketTourTargets(): Promise<string[]> {
    const out = new Set<string>();
    for (const r of (await this.store?.latestMarketSnapshots()) ?? []) out.add(r.waypointSymbol);
    // Trait-scan every charted system, not just home. Restricted to home, a
    // marketplace in an explored system stayed invisible here until something
    // had already recorded a price snapshot at it — and the only thing that
    // records one is a ship docking there, which first requires it to be a
    // tour target. That circle left real markets permanently unvisited:
    // X1-TV75 carries a second marketplace 216 units from its jump gate that
    // no ship ever called at, while scouts sat on the gate itself reporting
    // nothing to do. Targets outside a ship's current system are filtered by
    // the tour loop, which only flies same-system legs.
    for (const sys of this.galaxy.listSystems()) {
      for (const w of this.galaxy.getSystem(sys.symbol)?.waypoints ?? []) {
        if (w.traits.some((t) => t.symbol === "MARKETPLACE")) out.add(w.symbol);
      }
    }
    return [...out].sort();
  }

  /** Markets whose latest snapshot is older than the freshness window. */
  private async staleMarketTargets(): Promise<string[]> {
    const cutoff = new Date(Date.now() - this.doctrine.value("snapshotMaxAgeMin", 90) * 60_000).toISOString();
    const fresh = new Set<string>();
    for (const r of (await this.store?.latestMarketSnapshots()) ?? []) {
      if (r.timestamp >= cutoff) fresh.add(r.waypointSymbol);
    }
    return (await this.marketTourTargets()).filter((m) => !fresh.has(m));
  }

  /** Shipyard waypoints to tour periodically so ship stock stays fresh. */
  private async shipyardTourTargets(): Promise<string[]> {
    const out = new Set<string>();
    const knownSystems = new Set(this.galaxy.listSystems().map((s) => s.symbol));
    // Same reasoning as getIntel(): shipyard_inventory is a shared,
    // tenant-unscoped table that can carry rows from a system this agent's
    // reset doesn't have — sending a tour ship after one would just be a
    // wasted navigate call to a waypoint that no longer exists for it.
    for (const r of (await this.store?.shipyardInventory()) ?? []) if (knownSystems.has(r.systemSymbol)) out.add(r.waypointSymbol);
    const known = this.galaxy.getSystem(this.systemSymbol);
    for (const w of known?.waypoints ?? []) {
      if (w.traits.some((t) => t.symbol === "SHIPYARD")) out.add(w.symbol);
    }
    return [...out].sort();
  }

  /**
   * Sector-based market tour targets: each tour shuttle covers a distinct slice
   * of the system's markets so coverage spreads instead of every shuttle
   * clustering on the same nearest market. Markets are sorted by position and
   * split round-robin across the tour fleet.
   */
  private async sectorTourTargets(shipSymbol: string): Promise<string[]> {
    const all = await this.marketTourTargets();
    const tourShips = [...this.tours.keys()].sort();
    const idx = tourShips.indexOf(shipSymbol);
    if (idx < 0 || tourShips.length <= 1) return all;
    // Never slice away the markets of the system this ship is actually in.
    // The round-robin spreads coverage so shuttles don't cluster on the same
    // nearest market, but it splits a single global list sorted alphabetically
    // across every system, so a ship alone in a remote system had only a
    // 1-in-N chance of its own system's markets landing in its own slice.
    // Seen live: a scout sat on the X1-TP98 gate reporting "no reachable
    // target" while holding 37 of them, because the system's one in-range
    // market — 218 units away, the only one it could actually fly to — had
    // been dealt to another shuttle's slice, and no other shuttle was within
    // a jump of TP98.
    const here = this.tours.get(shipSymbol)?.getShip().nav.systemSymbol;
    const inThisSystem = (w: string) => here !== undefined && w.slice(0, w.lastIndexOf("-")) === here;
    return all.filter((w, i) => inThisSystem(w) || i % tourShips.length === idx);
  }

  /**
   * Assign a keeper market to a probe/satellite. Probes can't move, so the
   * keeper market must be where the probe already is — and that waypoint must
   * be a marketplace (so its prices are worth polling). Prefer shipyard-markets
   * (A2, C43, H56) since they're also where we buy ships.
   */
  private keeperMarketFor(ship: Ship): string | undefined {
    const here = ship.nav.waypointSymbol;
    const known = this.galaxy.getSystem(ship.nav.systemSymbol);
    const isMarket = known?.waypoints.some(
      (w) => w.symbol === here && w.traits.some((t) => t.symbol === "MARKETPLACE"),
    );
    if (!isMarket) return undefined;
    return here;
  }

  /** Snapshot a shipyard's inventory at a waypoint (only visible when docked). */
  async recordShipyardSnapshot(waypointSymbol: string): Promise<void> {
    const systemSymbol = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    try {
      const yard = await this.api.getShipyard(systemSymbol, waypointSymbol);
      await this.store?.recordShipyardInventory(systemSymbol, waypointSymbol, yard.ships ?? []);
      this.onActivity?.("shipyard", `snapshot ${waypointSymbol} (${(yard.ships ?? []).length} ships)`, 0);
    } catch (err) {
      // ignore: shipyard may not be scannable
    }
  }

  /**
   * Can `shipSymbol` physically get to `targetWaypoint` (same system)? A ship can
   * make the trip if the straight-line distance fits in one tank, or if there is a
   * chain of fuel stops where each hop fits in a full tank. Falls back to the
   * direct-tank check when positions are unknown.
   */
  private async canReachTarget(shipSymbol: string, targetWaypoint: string): Promise<boolean> {
    const ship = this.cachedShip(shipSymbol);
    const cap = ship?.fuel.capacity ?? 0;
    if (cap <= 0) return false;
    const start = this.shipWaypoint(shipSymbol);
    if (!start) return false;
    if (targetWaypoint === start) return true;
    const direct = this.estimatedFuelBetween(start, targetWaypoint);
    if (direct <= cap) return true;
    if (!Number.isFinite(direct)) return false;

    const systemSymbol = targetWaypoint.slice(0, targetWaypoint.lastIndexOf("-"));
    const stops = await this.fuelStops(systemSymbol);
    stops.add(start);
    stops.add(targetWaypoint);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of stops) {
        if (seen.has(next)) continue;
        if (this.estimatedFuelBetween(cur, next) <= cap) {
          if (next === targetWaypoint) return true;
          queue.push(next);
        }
      }
    }
    return false;
  }

  private async suspendAgent(symbol: string): Promise<void> {
    await this.controlledAgent(symbol)?.suspend();
    // Free the route immediately rather than leaving it reserved until the next
    // recompute (up to a minute later) for a ship that has already stopped
    // trading. dispatcherTraders() keeps it released for as long as it's
    // suspended; this just closes the window.
    this.dispatcher.release(symbol);
  }

  /**
   * The one path back to autonomy from every kind of borrowed control —
   * operator hold/dispatch, mission carrier duty, rescue tender duty.
   * docs/ship-control-state-audit.md, Phase 3: every caller used to hand-
   * roll its own subset of {agent.resume(), agent.release(),
   * dispatcher.release(), shipRegistry.release(), the persisted manual-
   * state flags} — the exact shape of the bugs fixed in Phases 0-2 was one
   * of those pieces getting left out. There is now only one thing to call,
   * and it always clears all of them, so a *new* borrower forgetting a
   * piece on the way out is no longer possible by construction.
   *
   * `owner` is the claim this release is entitled to — ShipRegistry.release()
   * is already a no-op unless the ship's current claim actually belongs to
   * `owner`, so calling this from the "wrong" context just doesn't touch a
   * claim it doesn't hold, rather than needing a guard here too.
   */
  private async releaseTo(shipSymbol: string, owner: ShipClaimOwner): Promise<void> {
    const agent = this.controlledAgent(shipSymbol);
    agent?.resume();
    agent?.release();
    // Free the route immediately rather than leaving it reserved until the
    // next recompute — same reasoning as suspendAgent()'s own call to this;
    // usually already a no-op here since suspending already released it, but
    // cheap and correct if some future borrower doesn't suspend first.
    this.dispatcher.release(shipSymbol);
    this.shipRegistry.release(shipSymbol, owner);
    // agent.release() above already unpins mining/clears the in-memory
    // manual goal (see ShipAgent.release) — this clears the *persisted*
    // mirror of the same thing, so a restart doesn't resurrect a hold this
    // ship no longer has.
    await this.updateShipManualState(shipSymbol, { holdWaypoint: null, minePin: null });
  }

  /**
   * The mission system's `resume` callback — its only caller — fires when a
   * carrier is released back to autonomy (mission paused/complete, or a new
   * carrier takes over). Fire-and-forget: mission.ts's own call sites never
   * awaited this before either (`resume` is declared as a sync callback),
   * and the DB write inside releaseTo() is best-effort persistence, not
   * something anything currently blocks on.
   */
  private resumeAgent(symbol: string): void {
    void this.releaseTo(symbol, "mission");
  }

  /** Known markets that sell a trade good in `systemSymbol`, cheapest first
   *  (for mission sourcing). System-scoped, not galaxy-wide — confirmed
   *  live: an unscoped lookup once returned a cheaper listing from a system
   *  with no jump gate connection to the mission's own, and the carrier
   *  tried (and failed) to route there every tick forever, invisible
   *  because the mission's own "no buyer known" fallback never triggered —
   *  a buyer, just an unreachable one, was always "found". */
  private async materialBuyers(tradeSymbol: string, systemSymbol: string): Promise<{ waypoint: string; purchasePrice: number; tradeVolume: number }[]> {
    const rows = (await this.store?.latestMarketSnapshots())?.filter((r) => r.goodSymbol === tradeSymbol && r.purchasePrice > 0 && r.systemSymbol === systemSymbol) ?? [];
    return rows
      .map((r) => ({ waypoint: r.waypointSymbol, purchasePrice: r.purchasePrice, tradeVolume: r.tradeVolume }))
      .sort((a, b) => a.purchasePrice - b.purchasePrice);
  }

  /** Survey unknown marketplaces in `systemSymbol` looking for a needed
   *  good. Scoped to that one system for the same reason materialBuyers()
   *  is: surveying (and potentially "finding") a seller in a system the
   *  mission's carrier can't actually reach wastes API calls and produces
   *  cached data materialBuyers() would then have to filter back out. */
  private async discoverMaterialBuyers(tradeSymbol: string, systemSymbol: string): Promise<{ waypoint: string; purchasePrice: number }[]> {
    // Before spending survey calls hunting for a seller, check whether this
    // good exists in the production economy at all — a good that appears
    // nowhere in the supply chain graph (neither as a raw export nor as
    // something an export feeds into) has no producer anywhere, and no
    // amount of surveying will ever find one. Best-effort: a failed fetch
    // (or the good genuinely being in the graph) just falls through to the
    // existing blind-survey behavior, unchanged.
    const chain = await getSupplyChain(this.api).catch(() => undefined);
    if (chain && !chain.knownGoods.has(tradeSymbol)) {
      this.log(`mission discovery: no known producer for ${tradeSymbol} in the supply chain — skipping survey`);
      return [];
    }
    const surveyed = new Set<string>();
    for (const r of (await this.store?.latestMarketSnapshots()) ?? []) if (r.systemSymbol === systemSymbol) surveyed.add(r.waypointSymbol);

    const known = this.galaxy.getSystem(systemSymbol);
    const candidates: { system: string; waypoint: string }[] = [];
    for (const w of known?.waypoints ?? []) {
      if (!w.traits.some((t) => t.symbol === "MARKETPLACE")) continue;
      if (surveyed.has(w.symbol)) continue;
      candidates.push({ system: systemSymbol, waypoint: w.symbol });
    }
    // Survey at most a small batch per call so we never hammer the API in one tick.
    const batch = candidates.slice(0, 6);
    for (const { system, waypoint } of batch) {
      try {
        const market = await this.api.getMarket(system, waypoint);
        for (const g of market.tradeGoods ?? []) {
          await this.store?.recordMarket({
            systemSymbol: system,
            waypointSymbol: waypoint,
            goodSymbol: g.symbol,
            type: g.type,
            supply: g.supply,
            purchasePrice: g.purchasePrice,
            sellPrice: g.sellPrice,
            tradeVolume: g.tradeVolume,
          });
        }
        this.log(`mission discovery: surveyed ${waypoint} (${market.tradeGoods?.length ?? 0} goods)`);
      } catch (err) {
        this.log(`mission discovery: ${waypoint} survey failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.materialBuyers(tradeSymbol, systemSymbol);
  }

  /** Active missions for the dashboard. */
  async getMissions() {
    return (await this.missions.list()).map((m) => ({ ...m, paused: this.missions.isPaused(m.targetWaypoint) }));
  }

  /** Start a construction-supply mission for a waypoint under construction. */
  startMission(waypointSymbol: string): Promise<void> {
    return this.missions.startConstruction(waypointSymbol);
  }

  /** Pause a construction mission (stop sourcing/spending). */
  async pauseMission(waypointSymbol: string): Promise<void> {
    await this.missions.pause(waypointSymbol);
  }

  /** Resume a paused construction mission. */
  async resumeMission(waypointSymbol: string): Promise<void> {
    await this.missions.resumeMission(waypointSymbol);
  }

  /**
   * Manually pick which ship carries a mission's supplies, instead of leaving
   * it to the auto-picker (biggest cargo hold that can reach the site). The
   * ship must have a cargo hold and not already be carrying a different
   * mission — reassigning a ship already committed elsewhere would strand
   * that mission's supply run.
   */
  async assignMissionCarrier(waypointSymbol: string, shipSymbol: string): Promise<void> {
    const agent = this.miners.get(shipSymbol) ?? this.traders.get(shipSymbol);
    if (!agent) throw new Error(`${shipSymbol} is not a miner or trader — missions need a cargo hold`);
    if ((agent.getShip().cargo?.capacity ?? 0) <= 0) throw new Error(`${shipSymbol} has no cargo hold`);
    const other = (await this.missions.list())
      .find((m) => m.assignedShip === shipSymbol && m.targetWaypoint !== waypointSymbol && m.status === "active");
    if (other) throw new Error(`${shipSymbol} is already carrying the mission at ${other.targetWaypoint}`);
    // Cutover (Greenfield Phase 4): an operator hold outranks a manual
    // mission assignment — the dashboard's own "manual" override for
    // missions still must not silently override a ship's operator hold.
    if (!this.shipRegistry.claim(shipSymbol, "mission", this.roleOf(shipSymbol))) {
      throw new Error(`${shipSymbol} can't be assigned to a mission — currently claimed by ${this.shipRegistry.ownerOf(shipSymbol)?.owner}`);
    }
    // stepCarrier() runs this exact same reachability check on every tick and
    // silently releases the carrier back to autonomy the instant it fails —
    // with nothing but a log line, no feedback to whoever assigned it.
    // Confirmed live: a manual assignment through the dashboard had no such
    // check at all (only pickMissionCarrier, the auto-picker, pre-filtered
    // for this), so assigning any cargo ship regardless of fuel range looked
    // like it worked right up until the next mission tick quietly undid it.
    // Reject here instead, with an error the operator actually sees — after
    // the claim check above, so a ship rejected for being held elsewhere
    // reports that reason, not an unrelated range problem.
    const ship = this.cachedShip(shipSymbol);
    if (ship && ship.fuel?.capacity > 0 && !(await this.canReachTarget(shipSymbol, waypointSymbol))) {
      this.shipRegistry.release(shipSymbol, "mission");
      throw new Error(`${shipSymbol} cannot reach ${waypointSymbol} on a full tank, even via refuel stops — pick a ship with more fuel range`);
    }
    await this.missions.assignCarrier(waypointSymbol, shipSymbol);
  }

  /**
   * Manually pin which trader buys+delivers a contract-deliverable good,
   * instead of leaving it to the dispatcher's own per-tick route computation
   * (computeContractBuyTargets() picking whichever idle trader the
   * dispatcher happens to route there). Unlike assignMissionCarrier(), this
   * doesn't seize the ship into raw-API control — a contractBuy assignment
   * is just a `manual` override on the same TraderAssignment the dispatcher
   * would have produced on its own (see toContractBuyAssignment()), so the
   * ship keeps running its normal tick()/deliverCargo loop, multi-hop
   * routing included.
   */
  async assignContractCarrier(shipSymbol: string, tradeSymbol: string): Promise<void> {
    const agent = this.traders.get(shipSymbol);
    if (!agent) throw new Error(`${shipSymbol} is not a trader — contract delivery needs a cargo hold`);
    if ((agent.getShip().cargo?.capacity ?? 0) <= 0) throw new Error(`${shipSymbol} has no cargo hold`);
    const cheapest = (await this.materialBuyers(tradeSymbol, this.systemSymbol))[0];
    if (!cheapest) throw new Error(`no known market sells ${tradeSymbol}`);
    await this.setManualDispatch(shipSymbol, {
      shipSymbol,
      good: tradeSymbol,
      role: "contractBuy",
      buyAt: cheapest.waypoint,
      buyPrice: cheapest.purchasePrice,
      profitPerTrip: 0,
      source: "manual",
    });
    this.log(`${shipSymbol}: manually assigned to contract-buy ${tradeSymbol} at ${cheapest.waypoint}`);
  }

  /** Estimate fuel needed to fly a ship from its current waypoint to a target. */
  estimatedFuelTo(shipSymbol: string, waypointSymbol: string): number {
    const ship = this.positions.find((p) => p.symbol === waypointSymbol);
    const here = this.positions.find((p) => p.symbol === this.shipWaypoint(shipSymbol));
    if (!ship || !here) return 0;
    return Math.max(1, Math.round(Math.hypot(ship.x - here.x, ship.y - here.y)));
  }

  private shipWaypoint(shipSymbol: string): string {
    for (const a of this.miners.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.traders.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.surveyors.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.scouts.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.siphoners.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    const idle = this.idleShips.get(shipSymbol);
    return idle?.nav.waypointSymbol ?? "";
  }

  /** Return the most recent cached Ship snapshot for a symbol, if known. */
  private cachedShip(shipSymbol: string): Ship | undefined {
    for (const a of this.miners.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.traders.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.surveyors.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.scouts.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.siphoners.values()) if (a.symbol === shipSymbol) return a.getShip();
    return this.idleShips.get(shipSymbol);
  }

  /**
   * Return cached shipyard + module intelligence for the dashboard.
   *
   * shipyard_inventory/module_catalog are shared, tenant-unscoped tables
   * (see Store's class doc comment) — deliberately, so two of the same
   * operator's own agents exploring the same live galaxy both benefit from
   * whichever one scouted a given waypoint first. But "unscoped" bit an
   * operator switching between agents from different SpaceTraders server
   * resets (confirmed live): the old agent's scans never expire or get
   * cleared, so they kept showing up forever alongside the new agent's,
   * with no way to tell which was still real. Filtering to systems this
   * fleet's own galaxy atlas has actually loaded (loadSystem() only ever
   * succeeds against the live API for systems that exist in the *current*
   * reset) is the natural scope — it keeps genuinely-shared intel between
   * a user's own concurrent agents on the same reset, while dropping
   * anything from a system this agent has no way to reach.
   */
  async getIntel(): Promise<{
    shipyards: Awaited<ReturnType<Store["shipyardInventory"]>>;
    modules: Awaited<ReturnType<Store["moduleCatalog"]>>;
  }> {
    const knownSystems = new Set(this.galaxy.listSystems().map((s) => s.symbol));
    const shipyards = ((await this.store?.shipyardInventory()) ?? []).filter((r) => knownSystems.has(r.systemSymbol));
    const modules = ((await this.store?.moduleCatalog()) ?? []).filter((r) => knownSystems.has(r.systemSymbol));
    return { shipyards, modules };
  }

  /** Non-expired surveys in the shared pool, optionally for one waypoint. */
  surveyData(waypoint?: string): ReturnType<SurveyPool["list"]> {
    return this.surveyPool.list(waypoint);
  }

  /** Pause/resume autonomous tick loop. Individual ship commands still work while paused. */
  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    if (this.tenantId) await this.store?.setFleetFlag(this.tenantId, "paused", paused ? "true" : "false");
    this.log(paused ? "fleet paused" : "fleet resumed");
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * The agent driving a ship, whatever its role. Every agent class exposes the
   * same control surface (dispatchTo/release/suspend/resume), so per-ship
   * commands work for surveyors and tour scouts too — not just the three roles
   * the dashboard used to reach.
   */
  private controlledAgent(shipSymbol: string): ControlledAgent | undefined {
    return (
      this.miners.get(shipSymbol) ??
      this.traders.get(shipSymbol) ??
      this.surveyors.get(shipSymbol) ??
      this.tours.get(shipSymbol) ??
      this.scouts.get(shipSymbol) ??
      this.siphoners.get(shipSymbol)
    );
  }

  /**
   * Ships `owner` could legally claim right now — the one definition of
   * "available", replacing three independent ones that used to each check
   * `!isManual() && !isSuspended()` plus their own extra conditions
   * (`dispatcherTraders`, `pickMissionCarrier`, `maybeAssignKeepers`). See
   * docs/ship-control-state-audit.md, Phase 1.
   *
   * Backed by ShipRegistry.available(), which answers from `syncShipClaims()`'s
   * once-per-tick snapshot — up to one tick (~2s) stale relative to a fresh
   * isManual()/isSuspended() read, same staleness the registry's own doc
   * comment already calls out. A ship with no claim recorded yet (the very
   * first tick after boot, or a ship purchased this same tick, before
   * syncShipClaims() has run even once) falls back to a direct agent check
   * instead of being misreported as unavailable — this is a narrow gap-filler
   * for "no claim exists yet", not a second definition of "busy".
   */
  private availableFor(owner: ShipClaimOwner): Set<string> {
    const out = new Set(this.shipRegistry.available(owner));
    for (const s of this.getShipStatuses()) {
      if (out.has(s.symbol) || this.shipRegistry.ownerOf(s.symbol)) continue;
      const agent = this.controlledAgent(s.symbol);
      if (agent && !agent.isManual() && !agent.isSuspended()) out.add(s.symbol);
    }
    return out;
  }

  /** This ship's current role, whichever map actually holds it — same lookup `getShipStatuses()` does inline, factored out for the ShipRegistry claim() call sites below. */
  private roleOf(shipSymbol: string): ShipClaimRole {
    if (this.miners.has(shipSymbol)) return "miner";
    if (this.traders.has(shipSymbol)) return "trader";
    if (this.surveyors.has(shipSymbol)) return "surveyor";
    if (this.tours.has(shipSymbol)) return "tour";
    if (this.keepers.has(shipSymbol)) return "keeper";
    if (this.scouts.has(shipSymbol)) return "scout";
    if (this.siphoners.has(shipSymbol)) return "siphoner";
    if (shipSymbol === this.warehouseShip?.shipSymbol) return "warehouse";
    return "idle";
  }

  /** Dispatch any ship to a specific waypoint, jumping systems if necessary. */
  async dispatchShip(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const targetSystem = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (ship.nav.systemSymbol !== targetSystem) {
      await this.jumpShip(shipSymbol, waypointSymbol);
      return;
    }

    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not under fleet control`);
    await agent.dispatchTo(waypointSymbol);
  }

  /**
   * Put one ship under manual control, holding it where it already is. This is
   * the per-ship counterpart to `setPaused`, which halts the whole fleet — the
   * dashboard's per-ship "stop" must never reach for the fleet-wide switch.
   * Deliberately does not route through `dispatchShip`, so a ship sitting at
   * 0 fuel (exactly the case an operator needs to take manual control of) can
   * still be held rather than failing a fuel pre-check.
   */
  async holdShip(shipSymbol: string): Promise<void> {
    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not under fleet control`);
    const here = this.shipWaypoint(shipSymbol) || (await this.api.getShip(shipSymbol)).nav.waypointSymbol;
    await agent.dispatchTo(here);
    await this.updateShipManualState(shipSymbol, { holdWaypoint: here });
    // A held ship stops trading, so it must stop reserving a good — otherwise
    // holding one trader quietly withdraws its route from the whole fleet.
    this.dispatcher.release(shipSymbol);
    // Cutover (Greenfield Phase 4): claim it for real, right now, rather than
    // waiting for the next coordinator tick's syncShipClaims() to notice —
    // operator is the strongest owner, so this always succeeds; preempt:true
    // just makes that explicit rather than relying on precedence math.
    this.shipRegistry.claim(shipSymbol, "operator", this.roleOf(shipSymbol), {}, { preempt: true });
    this.log(`${shipSymbol} held at ${here} under manual control`);
  }

  /** Manual hold + mining-field pin, keyed by ship, as one `fleet_flags` JSON
   *  blob — the same "small settings" mechanism `keeperMarkets` already uses.
   *  Read once at boot to replay holds/pins that would otherwise be lost. */
  private async loadShipManualState(): Promise<Record<string, { holdWaypoint?: string; minePin?: string }>> {
    const raw = this.tenantId ? await this.store?.getFleetFlag(this.tenantId, "shipManualState") : undefined;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async updateShipManualState(shipSymbol: string, patch: { holdWaypoint?: string | null; minePin?: string | null }): Promise<void> {
    if (!this.store || !this.tenantId) return;
    const all = await this.loadShipManualState();
    const next = { ...(all[shipSymbol] ?? {}) };
    if ("holdWaypoint" in patch) {
      if (patch.holdWaypoint) next.holdWaypoint = patch.holdWaypoint;
      else delete next.holdWaypoint;
    }
    if ("minePin" in patch) {
      if (patch.minePin) next.minePin = patch.minePin;
      else delete next.minePin;
    }
    if (Object.keys(next).length === 0) delete all[shipSymbol];
    else all[shipSymbol] = next;
    if (Object.keys(all).length === 0) await this.store.removeFleetFlag(this.tenantId, "shipManualState");
    else await this.store.setFleetFlag(this.tenantId, "shipManualState", JSON.stringify(all));
  }

  /**
   * Designate a ship as the warehouse: fly it to `waypointSymbol` and hold it
   * there permanently, same manual-dispatch/hold mechanism as any other
   * per-ship pin — there's no new stationary-ship role, this ship just never
   * gets released. Only one warehouse ship at a time; designating a new one
   * releases whichever ship held the job before.
   */
  async designateWarehouseShip(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`${shipSymbol} is not under fleet control`);
    if ((agent.getShip().cargo?.capacity ?? 0) <= 0) throw new Error(`${shipSymbol} has no cargo hold — can't warehouse anything`);
    // Cutover (Greenfield Phase 4): actually enforce precedence here, not
    // just record it — a ship an operator is holding, or one committed to a
    // mission, must not be silently repurposed as the warehouse ship out
    // from under whatever it was doing. `role: "warehouse"` matches what
    // getShipStatuses() (and syncShipClaims's mirror of it) already reports
    // for the designated ship, not this ship's pre-designation functional role.
    if (!this.shipRegistry.claim(shipSymbol, "warehouse", "warehouse")) {
      const ownerNow = this.shipRegistry.ownerOf(shipSymbol)?.owner;
      throw new Error(`${shipSymbol} can't be designated warehouse ship — currently claimed by ${ownerNow}`);
    }
    if (this.warehouseShip && this.warehouseShip.shipSymbol !== shipSymbol) {
      await this.releaseWarehouseShip();
    }
    await this.dispatchShip(shipSymbol, waypointSymbol);
    this.warehouseShip = { shipSymbol, waypointSymbol };
    if (this.tenantId) await this.store?.setFleetFlag(this.tenantId, "warehouseShip", JSON.stringify(this.warehouseShip));
    this.log(`${shipSymbol} designated warehouse ship, parked at ${waypointSymbol}`);
  }

  /** Hand the warehouse ship back to normal duty. */
  async releaseWarehouseShip(): Promise<void> {
    if (!this.warehouseShip) return;
    const { shipSymbol } = this.warehouseShip;
    this.warehouseShip = undefined;
    if (this.tenantId) await this.store?.removeFleetFlag(this.tenantId, "warehouseShip");
    // The warehouse claim, not "operator" — releaseShip() below releases
    // whatever operator hold this ship also happens to have, but the
    // warehouse ship's own claim owner is "warehouse", a separate release.
    this.shipRegistry.release(shipSymbol, "warehouse");
    try {
      await this.releaseShip(shipSymbol);
    } catch {
      // Ship may already be gone (scrapped) — nothing left to release.
    }
    this.log(`${shipSymbol} released from warehouse duty`);
  }

  /** Everything the warehouse currently holds, for the API/UI. */
  async warehouseGoods(): Promise<{ goodSymbol: string; units: number; avgCost: number; value: number }[]> {
    return (this.tenantId ? await this.store?.warehouseAll(this.tenantId) : undefined) ?? [];
  }

  /** Total value of everything the warehouse holds, at cost basis. */
  async warehouseValue(): Promise<number> {
    return (this.tenantId ? await this.store?.warehouseValue(this.tenantId) : undefined) ?? 0;
  }

  /** Recent warehouse deposits/withdrawals, newest first. */
  async warehouseLedger(limit?: number): Promise<{ timestamp: string; goodSymbol: string; delta: number; price: number; shipSymbol: string | null; reason: string }[]> {
    return (this.tenantId ? await this.store?.warehouseLedger(this.tenantId, limit) : undefined) ?? [];
  }

  /**
   * Manual operator adjustment to the warehouse's bookkeeping — corrections,
   * seeding initial stock, writing off a discrepancy. This is deliberately
   * bookkeeping-only, the same trust level as the dispatcher's manual route
   * override: it does not move any real cargo, so an operator using it to
   * "deposit" units that were never actually loaded onto the warehouse ship
   * will desync the books from the ship's real hold.
   */
  async adjustWarehouse(good: string, units: number, direction: "deposit" | "withdraw", price: number): Promise<{ units: number; avgCost: number }> {
    if (!this.store || !this.tenantId) throw new Error("store not available");
    if (direction === "deposit") {
      const newUnits = await this.store.warehouseDeposit(this.tenantId, good, units, price, undefined, "adjust");
      const avgCost = (await this.store.warehouseAll(this.tenantId)).find((g) => g.goodSymbol === good)?.avgCost ?? price;
      return { units: newUnits, avgCost };
    }
    const currentAvg = (await this.store.warehouseAll(this.tenantId)).find((g) => g.goodSymbol === good)?.avgCost ?? 0;
    return this.store.warehouseWithdraw(this.tenantId, good, units, currentAvg, undefined, "adjust");
  }

  /** The current warehouse ship and where it's parked, if one is designated. */
  getWarehouseShip(): { shipSymbol: string; waypointSymbol: string } | undefined {
    return this.warehouseShip;
  }

  /**
   * Dispatch a ship one hop closer to a same-system waypoint, refueling at a
   * fuel stop first if that's where it's starting from, so a ship with modest
   * range can eventually reach a distant target (e.g. the gate at I59) over
   * several calls. Uses the raw API for navigation so it works for any ship,
   * not just managed agents.
   *
   * Issues at most one navigate call and returns immediately — does NOT wait
   * for arrival. Confirmed live: the previous version blocked synchronously
   * (a real setTimeout sleep) until the ship physically arrived, for every
   * hop of the whole route. Since this runs inside missions.tick(), itself
   * awaited directly inside the shared fleet coordinator's tick(), a mission
   * actively moving its carrier toward a distant target — the jump gate in
   * this fleet's own case is 350+ units from where the fleet normally
   * operates — froze the ENTIRE coordinator (contracts, dispatch routes,
   * every other mission) for the full multi-leg trip. This is exactly the
   * class of bug the ETA-scheduled non-blocking waits elsewhere in this
   * engine (see docs/eta-scheduled-ship-waits.md) were built to eliminate —
   * it just never got extended to this raw-API mission/rescue dispatch path.
   * The caller (stepCarrier()) already re-checks `ship.nav.status ===
   * "IN_TRANSIT"` and returns early on every subsequent tick, so relying on
   * that instead of blocking here costs nothing: each ~2s tick either
   * notices the ship is still in flight (no-op) or has arrived, at which
   * point this gets called again for the next hop.
   */
  private async dispatchShipHop(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const targetSystem = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (ship.nav.systemSymbol !== targetSystem) {
      await this.dispatchShip(shipSymbol, waypointSymbol);
      return;
    }
    const cap = ship.fuel.capacity;
    if (cap <= 0) {
      await this.dispatchShip(shipSymbol, waypointSymbol);
      return;
    }
    if (ship.nav.status === "IN_TRANSIT") return; // already moving; next tick notices arrival
    const start = ship.nav.waypointSymbol;
    if (start === waypointSymbol) return;
    // Tracked locally rather than re-reading ship.nav.status after each call:
    // docking/refueling always leaves the ship DOCKED regardless of what it
    // was before, so the original captured `ship` snapshot goes stale the
    // moment any of those calls happen.
    let status = ship.nav.status;

    // Force CRUISE before any of this function's own fuel math or navigate
    // calls. Confirmed live: a ship handed off to the mission with its
    // flightMode still left at BURN from its own prior trading kept that
    // mode — nothing here ever reset it — so the real navigate call
    // consumed roughly double estimatedFuelBetween()'s straight-line
    // estimate (which assumes CRUISE) and failed with "requires N more
    // fuel" well within what should have been comfortable range. CRUISE is
    // the one mode estimatedFuelBetween() is actually calibrated for, and
    // there's no reason a mission supply run needs BURN's speed premium or
    // DRIFT's fuel thrift badly enough to justify the mismatch.
    if (ship.nav.flightMode !== "CRUISE") {
      await this.api.patchShipNav(shipSymbol, "CRUISE");
      this.log(`${shipSymbol}: flight mode forced to CRUISE for mission dispatch (was ${ship.nav.flightMode})`);
    }

    // If we're starting from a fuel stop, top up first so this hop uses a full tank.
    const startIsFuelStop = (await this.fuelStops(targetSystem)).has(start);
    if (startIsFuelStop) {
      if (status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
      await this.api.refuelShip(shipSymbol);
      status = "DOCKED";
      this.log(`${shipSymbol} topped up to full at ${start}`);
    }
    const budget = startIsFuelStop ? cap : ship.fuel.current;

    // If we can reach the target now, go straight there.
    if (this.estimatedFuelBetween(start, waypointSymbol) <= budget) {
      if (status !== "IN_ORBIT") await this.api.orbitShip(shipSymbol);
      const res = await this.api.navigateShip(shipSymbol, waypointSymbol);
      this.log(`${shipSymbol} en route ${start} -> ${waypointSymbol} (${res.fuel.current}/${res.fuel.capacity} fuel)`);
      return;
    }

    // Otherwise hop to whichever reachable fuel stop is closest to the
    // target, so each hop makes forward progress instead of wandering.
    const stops = [...(await this.fuelStops(targetSystem))].filter((s) => s !== waypointSymbol && s !== start);
    stops.sort((a, b) => this.estimatedFuelBetween(a, waypointSymbol) - this.estimatedFuelBetween(b, waypointSymbol));
    const next = stops.find((s) => this.estimatedFuelBetween(start, s) <= budget);
    if (!next) {
      this.log(`${shipSymbol} cannot hop toward ${waypointSymbol} from ${start} (no reachable fuel stop)`);
      return;
    }
    if (status !== "IN_ORBIT") await this.api.orbitShip(shipSymbol);
    const res = await this.api.navigateShip(shipSymbol, next);
    this.log(`${shipSymbol} hopping ${start} -> ${next} to refuel (${res.fuel.current}/${res.fuel.capacity} fuel)`);
  }

  /** Release a ship from manual dispatch back to autonomous operation. */
  /**
   * Pin a mining ship to one asteroid field. Unlike `dispatchShip`, this leaves
   * the ship working — it keeps mining, hauling and selling on its own, it just
   * stops picking the field.
   */
  async mineAt(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const agent = this.miners.get(shipSymbol) ?? this.surveyors.get(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not a mining or survey ship`);
    const type = this.galaxy.allPositions().find((p) => p.symbol === waypointSymbol)?.type;
    if (type && !["ASTEROID", "ASTEROID_FIELD", "ENGINEERED_ASTEROID"].includes(type)) {
      throw new Error(`${waypointSymbol} is a ${type}, not an asteroid field`);
    }
    agent.mineAt(waypointSymbol);
    await this.updateShipManualState(shipSymbol, { minePin: waypointSymbol });
    this.log(`${shipSymbol} pinned to mine at ${waypointSymbol}`);
  }

  /** Hand field selection back to a pinned mining ship. */
  async unpinMining(shipSymbol: string): Promise<void> {
    const agent = this.miners.get(shipSymbol) ?? this.surveyors.get(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not a mining or survey ship`);
    agent.unpinMining();
    await this.updateShipManualState(shipSymbol, { minePin: null });
  }

  /** The dashboard's explicit "release to autonomy" action — the one
   *  case where "ship isn't under fleet control" should surface as a real
   *  error to the operator, unlike releaseTo()'s other, best-effort
   *  internal callers. */
  async releaseShip(shipSymbol: string): Promise<void> {
    if (!this.controlledAgent(shipSymbol)) throw new Error(`ship ${shipSymbol} is not under fleet control`);
    await this.releaseTo(shipSymbol, "operator");
  }

  getShipStatuses(): { symbol: string; role: string; status: string; paused: boolean; pinnedField?: string }[] {
    const warehouseSymbol = this.warehouseShip?.shipSymbol;
    const notWarehouse = (s: string) => s !== warehouseSymbol;
    const statuses = [
      ...[...this.miners.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "miner", status: a.getShip().nav.status, paused: a.isManual(), pinnedField: a.pinnedField() })),
      ...[...this.traders.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "trader", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.surveyors.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "surveyor", status: a.getShip().nav.status, paused: a.isManual(), pinnedField: a.pinnedField() })),
      ...[...this.tours.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "tour", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.keepers.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "keeper", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.scouts.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "scout", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.siphoners.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "siphoner", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.idleShips.keys()].filter(notWarehouse).map((s) => ({ symbol: s, role: "idle", status: "IDLE", paused: false })),
    ];
    if (warehouseSymbol) {
      const agent = this.controlledAgent(warehouseSymbol);
      if (agent) statuses.push({ symbol: warehouseSymbol, role: "warehouse", status: agent.getShip().nav.status, paused: agent.isManual() });
    }
    return statuses;
  }

  /**
   * A compact, human-readable "what is every ship doing right now" summary —
   * one line per ship, derived from data already in memory (no API calls).
   * This is what the coordinator logs once per tick and what the dashboard
   * surfaces, so a ship that's idle/cooldown/transit is visible instead of
   * silently absent from the log stream. `doing` is a short reason string:
   * stranded / manual hold / suspended / cooldown Ns / transit → dest /
   * docked / in orbit / idle.
   */
  fleetStatusSummary(): { symbol: string; role: string; waypoint: string; nav: string; fuel: number; fuelCap: number; cargo: number; cargoCap: number; cooldown: number; doing: string }[] {
    const stranded = new Set(this.getStrandedShips().map((s) => s.symbol));
    return this.getShipStatuses().map((s) => {
      const ship = this.shipFor(s.symbol);
      const agent = this.controlledAgent(s.symbol) ?? this.keepers.get(s.symbol);
      const nav = ship?.nav?.status ?? s.status;
      const waypoint = ship?.nav?.waypointSymbol ?? "";
      const fuel = ship?.fuel?.current ?? 0;
      const fuelCap = ship?.fuel?.capacity ?? 0;
      const cargo = ship?.cargo?.units ?? 0;
      const cargoCap = ship?.cargo?.capacity ?? 0;
      const cooldown = ship?.cooldown?.remainingSeconds ?? 0;
      const dest = ship?.nav?.route?.destination?.symbol;
      let doing: string;
      if (stranded.has(s.symbol)) doing = "stranded";
      else if (s.paused) doing = "manual hold";
      else if (agent?.isSuspended()) doing = "suspended";
      else if (cooldown > 0) doing = `cooldown ${cooldown}s`;
      else if (nav === "IN_TRANSIT") doing = dest ? `transit → ${dest}` : "transit";
      else if (nav === "DOCKED") doing = "docked";
      else if (nav === "IN_ORBIT") doing = "in orbit";
      else doing = (nav || "idle").replace(/_/g, " ").toLowerCase();
      return { symbol: s.symbol, role: s.role, waypoint, nav, fuel, fuelCap, cargo, cargoCap, cooldown, doing };
    });
  }

  /** One aggregated log line for the whole fleet, logged once per coordinator tick. */
  private logFleetStatus(): void {
    const parts = this.fleetStatusSummary().map(
      (s) => `${s.symbol}(${s.role})@${s.waypoint ? s.waypoint.slice(-4) : "?"} ${s.doing} f${s.fuel}/${s.fuelCap} c${s.cargo}/${s.cargoCap}`,
    );
    this.log(`fleet: ${parts.join(" | ") || "no ships"}`);
  }

  /**
   * Greenfield Phase 2: persist a lifecycle state per ship — idle | assigned
   * | travelling | returning | docked | transacting — derived from
   * `getShipStatuses()`'s role + live SpaceTraders nav status, so
   * `ship_state` has a real record of what every ship was doing even before
   * the next dashboard read re-derives it live.
   *
   * `transacting` and `step` now come from each agent's own `getStep()`
   * (see agentStep.ts) — every agent class sets `currentStep` around its
   * actual buy/sell/extract/siphon/survey API calls and its one shared
   * navigation entry point, so this is a real, if best-effort, signal: a
   * `transacting` step is only observable here if a coordinator tick
   * happens to land while that specific `await` is still in flight (a
   * real if narrow window — network latency, not zero), not manufactured.
   * `transacting` takes priority over the nav-status-derived state when
   * present. `returning` is `travelling` with cargo already in the hold —
   * in transit and carrying something reads as heading toward a sale/
   * delivery, not away from one. `target` is the transit destination while
   * travelling/returning/transacting mid-navigation, the current waypoint
   * otherwise, falling back to the agent's own reported navigation target
   * when nav data disagrees (mid-flight step vs. a stale cached ship object).
   */
  private async syncShipStates(): Promise<void> {
    if (!this.tenantId || !this.store) return;
    const statuses = this.getShipStatuses();
    await Promise.all(
      statuses.map((s) => {
        const ship = this.shipFor(s.symbol);
        const step = this.stepFor(s.symbol);
        const carryingCargo = (ship?.cargo?.units ?? 0) > 0;
        const state = step.kind === "transacting"
          ? "transacting"
          : s.role === "idle"
            ? "idle"
            : s.status === "IN_TRANSIT"
              ? (carryingCargo ? "returning" : "travelling")
              : s.status === "DOCKED"
                ? "docked"
                : "assigned";
        const target = step.kind === "navigating"
          ? step.to
          : s.status === "IN_TRANSIT"
            ? ship?.nav?.route?.destination?.symbol
            : ship?.nav?.waypointSymbol;
        const persistedStep = step.kind === "idle" ? undefined : step;
        return this.store!.updateShipState(this.tenantId!, s.symbol, state, target, persistedStep);
      }),
    );
  }

  /** A ship's full current object, whichever role map (or idleShips) actually holds it — controlledAgent() alone misses keepers, same gap noted on that method. */
  private shipFor(shipSymbol: string): Ship | undefined {
    const agent = this.controlledAgent(shipSymbol) ?? this.keepers.get(shipSymbol);
    return agent ? agent.getShip() : this.idleShips.get(shipSymbol);
  }

  /** What the ship's agent is doing right now (see agentStep.ts) — idle for an idle ship (no agent driving it) or a fake test agent that doesn't implement getStep(). */
  private stepFor(shipSymbol: string): AgentStep {
    const agent = this.controlledAgent(shipSymbol) ?? this.keepers.get(shipSymbol);
    return agent?.getStep?.() ?? IDLE_STEP;
  }

  /** A ship's current cargo inventory, whichever role map (or idleShips) actually holds it. */
  private cargoForShip(shipSymbol: string): { symbol: string; units: number }[] {
    return this.shipFor(shipSymbol)?.cargo?.inventory ?? [];
  }

  /**
   * Greenfield Phase 3: reconcile the persisted `ship_manifest` against each
   * ship's real cargo, once per coordinator tick (same cadence as
   * `syncShipStates`). Now assigns all four of the design doc's intents:
   *
   * - `warehouse-deposit` — the warehouse ship's own hold.
   * - `mission-delivery` — a ship `MissionManager.committedShips()` has
   *   assigned, the same lookup `syncShipClaims()` already uses to derive
   *   the `"mission"` claim owner.
   * - `held-position` — a good whose current market sell price, at this
   *   ship's own waypoint, is below its cost basis by more than
   *   `HELD_POSITION_MAX_LOSS_PCT`. This mirrors `TraderAgent`'s own
   *   private `exceedsLossFloor()` check (`price < cost * (1 - maxLossPct
   *   / 100)`, same formula) — the real hold-below-a-loss-floor decision
   *   that `clearLeftoverCargo()` and the other sell paths in trader.ts
   *   already make and always did; this just gives the manifest visibility
   *   into that decision, using the Phase 1 `market_latest` projection
   *   instead of a fresh API call. Deliberately re-derived here rather than
   *   reading `TraderAgent`'s own private state directly: this runs for
   *   every role (not just traders), and a manifest-side approximation
   *   using a fixed percentage is enough for classification/dashboard
   *   display — it doesn't gate any real sell decision, which still goes
   *   through each trader's own live check with its own configured
   *   `maxLossPct`.
   * - `resale` — everything else, the default.
   *
   * Cost basis prefers this ship's own last purchase of the good
   * (`basisKind: 'actual'`); falls back to the fleet-wide volume-weighted
   * average, then 0, when this ship never bought it itself (picked it up
   * via mining, a transfer, or contract fulfillment instead).
   */
  private async syncShipManifests(): Promise<void> {
    if (!this.tenantId || !this.store) return;
    const store = this.store;
    const tenantId = this.tenantId;
    const warehouseSymbol = this.warehouseShip?.shipSymbol;
    const committed = this.missions.committedShips();
    // One query, reused across every ship this tick — same pattern
    // syncShipClaims() uses for committedShips(), and an improvement over
    // this method's previous per-ship-per-good store round trips.
    const marketSnapshots = await store.latestMarketSnapshots();
    for (const s of this.getShipStatuses()) {
      const inventory = this.cargoForShip(s.symbol);
      const existing = await store.getManifestForShip(tenantId, s.symbol);
      const held = new Set(inventory.map((i) => i.symbol));
      const stale = existing.filter((m) => !held.has(m.goodSymbol)).map((m) => m.goodSymbol);
      if (stale.length) await store.deleteManifestRows(tenantId, s.symbol, stale);
      if (inventory.length === 0) continue;

      const waypoint = this.shipWaypoint(s.symbol);
      const rows = await Promise.all(
        inventory.map(async (item) => {
          const actual = await store.lastPurchasePrice(tenantId, s.symbol, item.symbol);
          const costBasis = actual ?? (await store.avgPurchasePrice(tenantId, item.symbol)) ?? 0;
          const basisKind = (actual !== undefined ? "actual" : "estimated") as "actual" | "estimated";

          let intent: CargoIntent;
          if (s.symbol === warehouseSymbol) {
            intent = "warehouse-deposit";
          } else if (committed.has(s.symbol)) {
            intent = "mission-delivery";
          } else {
            const marketRow = marketSnapshots.find((m) => m.waypointSymbol === waypoint && m.goodSymbol === item.symbol);
            const floor = costBasis * (1 - HELD_POSITION_MAX_LOSS_PCT / 100);
            const belowFloor = costBasis > 0 && marketRow !== undefined && marketRow.sellPrice < floor;
            intent = belowFloor ? "held-position" : "resale";
          }

          return { shipSymbol: s.symbol, goodSymbol: item.symbol, units: item.units, costBasis, basisKind, intent };
        }),
      );
      await store.upsertManifestRows(tenantId, rows);
    }
  }

  /**
   * Greenfield Phase 4: mirror fleet.ts's own ownership decisions into
   * `shipRegistry` (in-memory) and persist them, once per coordinator tick
   * alongside `syncShipStates`/`syncShipManifests`. `owner` is derived from
   * state fleet.ts already tracks: `operator` for a manually-dispatched/held
   * ship (`isManual()`), `warehouse` for the designated warehouse ship,
   * `mission` for a ship `MissionManager.committedShips()` currently has
   * assigned, `keeper` for a stationed keeper, `auto` for everything else —
   * the coordinator's own default role assignment.
   *
   * Every call passes `preempt: true`. That's deliberate, not a loophole:
   * this is a mirror of one real decision, not two independently-arbitrated
   * claimants, so the freshly-recomputed owner must always win even when
   * it's weaker than what was persisted last tick — e.g. an operator
   * releasing a held ship back to `auto` has to actually downgrade the
   * claim, which plain `claim()` precedence rules would otherwise block.
   * Real precedence enforcement (rejecting a genuinely competing claim) is
   * exercised by ShipRegistry's own tests; nothing in fleet.ts's dispatch
   * paths calls `claim()`/`release()` directly yet — see shipRegistry.ts's
   * class comment and README's Greenfield section for why that's Phase 4's
   * deliberate dual-write scope, not a gap.
   *
   * Known gap: a scrapped ship's claim is never explicitly released here
   * (only ships `getShipStatuses()` still reports get touched) — harmless
   * today since nothing yet reads `shipRegistry` as a gate, but real if a
   * later phase starts trusting `available()`'s output without also
   * pruning scrapped ships elsewhere.
   */
  private async syncShipClaims(): Promise<void> {
    if (!this.tenantId || !this.store) return;
    const warehouseSymbol = this.warehouseShip?.shipSymbol;
    const committed = this.missions.committedShips();
    // Phase 2 (docs/ship-control-state-audit.md): a fuel tender now claims
    // "rescue" the moment it's picked (see makeRescuePlan()), but this mirror
    // runs later in the same tick and previously had no concept of "rescue"
    // at all — it would derive "auto" for a suspended tender (not paused,
    // not a mission carrier, not a keeper) and overwrite the claim it had
    // just been given, with preempt:true, on the very same tick. Reading
    // rescuePlans directly here is the ground truth for "is this ship
    // actively tendering right now", same idea as `committed` below for
    // missions.
    const tendering = new Set([...this.rescuePlans.values()].map((p) => p.tenderSymbol));
    // Same reasoning as `tendering` above, for maybeRepairFleet()'s critical-
    // condition diversions — repairPlans is ground truth for "actively being
    // routed to a shipyard right now", read directly rather than re-derived,
    // for the identical same-tick-overwrite reason.
    const repairing = this.repairPlans;
    for (const s of this.getShipStatuses()) {
      // The warehouse ship must be checked before `s.paused`: designating
      // it uses the exact same dispatchTo()/manual-hold mechanism as an
      // operator hold (see designateWarehouseShip()'s own comment — "the
      // same manual-dispatch/hold mechanism as any other per-ship pin"), so
      // `isManual()` is genuinely true for it too. Checking `paused` first
      // would misreport it as "operator" — invisible right after
      // designateWarehouseShip()'s own inline claim() call sets "warehouse"
      // correctly, but silently overwritten back to "operator" the very
      // next tick, since this resync always runs with preempt:true. Caught
      // by tests/integration.test.ts's 100-tick scenario, not by any
      // single-tick test — the bug only shows up on the *second* resync.
      const owner: ShipClaimOwner = s.symbol === warehouseSymbol
        ? "warehouse"
        : s.paused
          ? "operator"
          : tendering.has(s.symbol)
            ? "rescue"
            : repairing.has(s.symbol)
              ? "repair"
              : committed.has(s.symbol)
                ? "mission"
                : s.role === "keeper"
                  ? "keeper"
                  : "auto";
      // Phase 4 (docs/ship-control-state-audit.md), the "smaller alternative":
      // a full rewrite of every agent's run-loop gating onto a registry read
      // was judged too risky to do blind (no live-game test coverage). This
      // is the cheap version — a mission/rescue owner is *supposed* to mean
      // the agent is suspended (a subsystem is driving it via raw API calls,
      // not its own tick()); if it isn't, that's exactly the "partial
      // handback" pattern behind every bug this audit started from.
      //
      // Originally detection-only, never correcting — logged and left alone
      // so it "can't introduce a new way to strand a ship". Confirmed live
      // that drift is real, not just theoretical: a ship correctly claimed
      // "mission" kept running its own ordinary trading loop in parallel
      // (buying and selling goods that had nothing to do with the mission),
      // completely invisible unless someone happened to read this exact log
      // line. Actually suspending it here is a much narrower move than the
      // deferred full rewrite — it doesn't change any agent's own gating
      // logic, it just makes the agent's suspended flag match the ownership
      // this tick already decided on, the same call assignCarrier()/the
      // rescue tender picker make when they first hand off control. A ship
      // this fires for was always supposed to be suspended; this just stops
      // that supposed-to-be from silently staying false.
      const agent = this.controlledAgent(s.symbol);
      if ((owner === "mission" || owner === "rescue" || owner === "repair") && agent && !agent.isSuspended()) {
        this.log(`ship control drift: ${s.symbol} claimed as "${owner}" but its agent reports isSuspended()=false — suspending it now`);
        await agent.suspend();
      }
      this.shipRegistry.claim(s.symbol, owner, s.role as ShipClaimRole, { status: s.status }, { preempt: true });
    }
    await this.shipRegistry.persistDirtyState(this.tenantId, this.store);
  }

  /**
   * Cutover: ensure every currently-known agent has exactly one live
   * `nextTask()` chain enqueued on `scheduler`, once per tick alongside
   * `syncShipStates`/`syncShipManifests`/`syncShipClaims`. Idempotent per
   * ship — once a ship's first task is enqueued, its own chain
   * (`TaskResult.next`) keeps it running on its own; this just notices
   * *new* agents (a fresh ship purchase, a role promotion, a keeper
   * conversion) and gives them their first task. A no-op when `scheduler`
   * wasn't provided to this FleetManager — see FleetOptions.scheduler's
   * comment for why that's the default.
   */
  private syncSchedulerTasks(): void {
    if (!this.scheduler) return;
    const scheduler = this.scheduler;
    if (!this.rescueScheduled) {
      scheduler.enqueue(this.nextRescueTask());
      this.rescueScheduled = true;
    }
    const live = new Set<string>();
    const schedule = (sym: string, agent: { running: boolean }, makeTask: () => Task): void => {
      live.add(sym);
      if (this.scheduledShips.has(sym)) return;
      agent.running = true;
      scheduler.enqueue(makeTask());
      this.scheduledShips.add(sym);
    };
    for (const [sym, a] of this.miners) schedule(sym, a, () => a.nextTask());
    for (const [sym, a] of this.traders) schedule(sym, a, () => a.nextTask());
    for (const [sym, a] of this.surveyors) schedule(sym, a, () => a.nextSurveyTask());
    for (const [sym, a] of this.tours) schedule(sym, a, () => a.nextTourTask());
    for (const [sym, a] of this.keepers) schedule(sym, a, () => a.nextKeeperTask());
    for (const [sym, a] of this.scouts) schedule(sym, a, () => a.nextTask());
    for (const [sym, a] of this.siphoners) schedule(sym, a, () => a.nextTask());
    // A ship no longer in any role map (scrapped, or converted to a
    // different role) already had stop() called on its old agent elsewhere
    // (removeShip(), maybeAssignKeepers()) — its own running=false check
    // ends that chain on its own. This just stops tracking it, so a
    // symbol reused later (never happens in practice — SpaceTraders symbols
    // are unique) would be treated as fresh.
    for (const sym of [...this.scheduledShips]) if (!live.has(sym)) this.scheduledShips.delete(sym);
  }

  /**
   * Cutover: `rescueStranded()` as a fleet-level (not per-ship) Scheduler
   * `Task`, priority 0 — the highest, matching the design doc's own
   * priority scheme (0 rescue · 1 mission · 2 trade · 3 survey/keeper ·
   * 4 telemetry). This is the concrete payoff of routing rescue through the
   * scheduler at all: `Scheduler.runOnce()` already only admits priority-0
   * tasks while the fleet is paused, so once this task exists, "rescue
   * always runs, even halted, even under budget pressure" is a property of
   * the scheduler's own admission logic — not, as it was before this cutover,
   * something that happened to be true only because `tick()` called
   * `rescueStranded()` directly regardless of anything else. Deliberately
   * does NOT check `this.halted()` the way every per-ship `nextTask()` does:
   * unlike those, this task's whole point is to keep running through a halt.
   *
   * Enqueued once (`rescueScheduled`), from `syncSchedulerTasks()`, then
   * self-chains forever on a fixed ~2s cadence — the same interval
   * `FleetManager.run()`'s own coordinator loop already polls at, since
   * rescue needs to notice a newly-stranded ship quickly, not back off like
   * an idle per-ship task would.
   */
  private nextRescueTask(earliestRunAt = Date.now()): Task {
    return {
      id: "fleet-rescue",
      priority: 0,
      estimatedCalls: 5,
      earliestRunAt,
      run: async (): Promise<TaskResult> => {
        if (!this.running) return { actualCalls: 0 };
        const before = this.api.getCallCount();
        try {
          await this.rescueStranded();
        } catch (err) {
          this.log(`rescue task error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { actualCalls: this.api.getCallCount() - before, next: this.nextRescueTask(Date.now() + 2_000) };
      },
    };
  }

  /** Detect ships stranded without enough fuel to reach any known market. */
  /**
   * What's actually happening about a stranded ship's rescue, right now —
   * distinct from `reason` (why it's stranded). Previously the dashboard
   * had no way to tell "a tender is genuinely en route" from "no tender
   * will ever come without operator intervention"; both looked identical
   * (just "stranded"). See makeRescuePlan()'s own comment for the incident
   * this closes.
   */
  private rescueStatusFor(shipSymbol: string): { rescueActive: boolean; rescueDetail: string } {
    const plan = this.rescuePlans.get(shipSymbol);
    if (plan) {
      const phaseLabel = { buy: "buying fuel", transit: "en route", transfer: "transferring fuel", done: "delivering" }[plan.phase];
      return { rescueActive: true, rescueDetail: `fuel tender ${plan.tenderSymbol} dispatched (${phaseLabel})` };
    }
    const failure = this.rescueFailures.get(shipSymbol);
    if (failure) return { rescueActive: false, rescueDetail: `no rescue possible: ${failure}` };
    return { rescueActive: false, rescueDetail: "evaluating rescue options" };
  }

  getStrandedShips(): { symbol: string; waypointSymbol: string; fuel: number; reason: string; rescueActive: boolean; rescueDetail: string }[] {
    const stranded: { symbol: string; waypointSymbol: string; fuel: number; reason: string; rescueActive: boolean; rescueDetail: string }[] = [];
    for (const ship of [...this.miners.values(), ...this.traders.values()]) {
      const s = ship.getShip();
      if (s.fuel.capacity <= 0) continue;
      // A trader that flagged itself stranded (navigation failed for lack of
      // fuel) needs a tender even if it still has a few units left.
      const flagged = this.traders.get(s.symbol)?.isStranded() ?? false;
      if (flagged) {
        stranded.push({
          symbol: s.symbol,
          waypointSymbol: s.nav.waypointSymbol,
          fuel: s.fuel.current,
          reason: "marked stranded (insufficient fuel to reach a market)",
          ...this.rescueStatusFor(s.symbol),
        });
        continue;
      }
      if (s.fuel.current > 0) continue;
      const atMarket = this.positions.some(
        (p) => p.symbol === s.nav.waypointSymbol && this.galaxy.getSystem(s.nav.systemSymbol)?.waypoints.some((w) => w.symbol === p.symbol && w.traits.some((t) => t.symbol === "MARKETPLACE")),
      );
      if (atMarket) continue;
      stranded.push({
        symbol: s.symbol,
        waypointSymbol: s.nav.waypointSymbol,
        fuel: s.fuel.current,
        reason: "0 fuel and not at a market",
        ...this.rescueStatusFor(s.symbol),
      });
    }
    return stranded;
  }

  /**
   * Refresh the cached credit balance, at most once per `CREDITS_TTL_MS`.
   *
   * This used to run on every 2s coordinator tick — 0.5 req/s of a 2 req/s
   * budget for a number that only gates "should I consider buying a ship" and
   * route affordability ranking. Neither needs second-resolution: a stale-high
   * value at worst attempts a purchase the API refuses, a stale-low one defers
   * a purchase by a few seconds. The paths where an exact balance actually
   * matters — `TraderAgent.runBuy` and the mission carrier's buy sizing — read
   * it live at the point of purchase and are unaffected by this.
   */
  private async refreshCredits(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCreditsFetch < CREDITS_TTL_MS) return;
    this.lastCreditsFetch = now;
    try {
      this.credits = (await this.api.getMyAgent()).credits;
    } catch (err) {
      // ignore: credits refresh is best-effort
    }
  }

  /**
   * The API allows at most one ongoing or offered contract at a time — this
   * only ever does anything when the fleet genuinely has none, which
   * `listActive()`'s own 30s cache makes cheap to check every tick. Prefers
   * an idle ship (nothing else to interrupt); otherwise any non-manual ship
   * that isn't mid-transit works, since negotiating just needs presence at
   * a waypoint with a faction, not any particular role or the flagship.
   * A 60s cooldown after a failed attempt (no eligible ship right now, or
   * the API rejected it) stops a persistent failure from retrying every 2s
   * tick indefinitely.
   */
  private async maybeNegotiateContract(): Promise<void> {
    if (!this.contracts) return;
    const active = await this.contracts.listActive();
    if (active.length > 0) return;
    if (Date.now() - this.lastNegotiateAttempt < 60_000) return;

    const statuses = this.getShipStatuses();
    const candidate =
      statuses.find((s) => s.role === "idle" && s.status !== "IN_TRANSIT") ??
      statuses.find((s) => s.status !== "IN_TRANSIT" && !s.paused);
    if (!candidate) return;

    this.lastNegotiateAttempt = Date.now();
    try {
      const contract = await this.contracts.negotiate(candidate.symbol);
      this.log(`negotiated contract ${contract.id} via ${candidate.symbol}`);
    } catch (err) {
      this.log(`negotiateContract via ${candidate.symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Refresh cached construction status for every known gate not yet
   * confirmed complete. A gate's status changes at most once ever (under
   * construction → complete), so this is throttled to a slow interval —
   * every tick would just spend rate-limit budget re-asking a question
   * that essentially never has a new answer. canJump()'s callers
   * (computeDispatchRoutes(), viableRoute(), freeChoice(), runBuy/runSell/
   * runHaul) only ever read the cache this populates; none of them make
   * this call themselves.
   */
  private async maybeRefreshGateConstruction(): Promise<void> {
    if (Date.now() - this.lastGateConstructionRefresh < 5 * 60_000) return;
    this.lastGateConstructionRefresh = Date.now();
    await this.galaxy.refreshAllGateConstruction();
  }

  /** One coordination pass over the whole fleet. */
  async tick(): Promise<void> {
    if (this.paused) {
      // Halt stops *automation*, not *recovery*. Rescue is the one thing that
      // must keep running: a halted fleet still has ships sitting at 0 fuel,
      // and previously pausing switched off the only mechanism that recovers
      // them while leaving every ship loop running — so a Halt actively made
      // stranding more likely. With a scheduler, nextRescueTask() (priority 0,
      // admitted by Scheduler.runOnce() even while paused) already covers
      // this — calling it directly here too would just run it twice. Without
      // one, this direct call is still what makes rescue halt-proof.
      if (!this.scheduler) await this.rescueStranded();
      await this.syncShipStates();
      await this.syncShipManifests();
      await this.syncShipClaims();
      this.syncSchedulerTasks();
      this.logFleetStatus();
      return;
    }
    await this.refreshCredits();
    await this.maybeRefreshGateConstruction();
    if (this.contracts) {
      await this.contracts.fulfillCompleted();
      await this.contracts.acceptBest();
      await this.maybeNegotiateContract();
    }
    // Centralized route dispatch: recompute distinct per-trader assignments.
    const routes = await this.computeDispatchRoutes();
    const [warehouseTargets, haulTargets, missionBuyTargets, contractBuyTargets] = await Promise.all([
      this.computeWarehouseTargets(routes),
      this.computeHaulTargets(),
      this.computeMissionBuyTargets(),
      this.computeContractBuyTargets(),
    ]);
    await this.releaseFulfilledManualContractBuys(contractBuyTargets);
    this.dispatcher.recompute(
      routes,
      this.dispatcherTraders(),
      warehouseTargets,
      haulTargets,
      missionBuyTargets,
      contractBuyTargets,
      (from, to) => this.galaxy.canJump(from, to),
      (m) => this.log(m),
    );
    await this.maybeAssignKeepers();
    await this.maybeRepairFleet();
    await this.maybeBuyShip();
    await this.maybeBuyScout();
    await this.maybeBuySiphoner();
    await this.maybeInstallScanner();
    await this.autoExplore();
    // Cutover: with a scheduler, nextRescueTask() (enqueued once from
    // syncSchedulerTasks(), self-chained every ~2s) already covers this —
    // see the halted branch above for why calling it here too would double
    // it up. Without one, this direct call is unchanged from before.
    if (!this.scheduler) await this.rescueStranded();
    await this.missions.tick();
    await this.syncShipStates();
    await this.syncShipManifests();
    await this.syncShipClaims();
    this.syncSchedulerTasks();
    this.logFleetStatus();
  }

  /**
   * Station keepers at the highest-value buy markets so their prices never go
   * stale. Probes already park at shipyard-markets (A2/C43/H56). This converts
   * idle miners (then idle shuttles) into keepers at the outer buy markets the
   * dispatcher prices routes from (D46, E48, K85, F52, E49) — a miner earns
   * ~2k/hr mining, but one fresh route is worth far more.
   */
  private async maybeAssignKeepers(): Promise<void> {
    const target = this.doctrine.value("keeperCount", 0);
    if (target <= 0) return;
    const coverList = await this.keeperCoverList();
    const priority = await this.keeperPriorityMarkets();
    // Prefer an idle miner (empty hold, not manual, not suspended); fall back
    // to an idle tour shuttle so we never block on a busy ship. Drains the
    // whole uncovered list in one pass when coverList is on; otherwise stops at
    // the keeperCount cap. The conversion itself makes no API calls, so the old
    // one-ship-per-pass crawl just wasted minutes.
    // The command ship is never a candidate, no matter how it's equipped —
    // a fleet's flagship (registration.role === "COMMAND") shouldn't get
    // parked as a market listener just because an operator fitted it with a
    // mining laser, which is otherwise the only way it could even end up in
    // `this.miners` at all (assignRole() only routes a COMMAND-role ship to
    // `traders`, not `miners`, when it isn't mining-equipped).
    // availableFor("keeper") replaces the old !isManual() && !isSuspended()
    // half of this check (docs/ship-control-state-audit.md, Phase 1); cargo-
    // empty and not-COMMAND stay as genuinely keeper-specific predicates
    // layered on top, not folded into the shared availability answer.
    const available = this.availableFor("keeper");
    const idle = (sym: string, a: ShipAgent) => available.has(sym) && (a.getShip().cargo?.units ?? 0) === 0 && a.getShip().registration?.role !== "COMMAND";
    const miners = [...this.miners.entries()].filter(([sym, a]) => idle(sym, a));
    const shuttles = [...this.tours.entries()].filter(([sym, a]) => idle(sym, a));
    for (;;) {
      const need = await this.priorityUncovered();
      if (need.length === 0) break;
      if (!coverList && this.keepers.size >= target) break;
      const miner = miners.shift();
      const source = miner ?? shuttles.shift();
      if (!source) break;
      const [sym, agent] = source;
      const what = miner ? "miner" : "shuttle";
      const market = need[0]!;
      // Cutover (Greenfield Phase 4): the idle() filter above already
      // excludes manual/suspended ships (MissionManager suspends its
      // carriers, so a mission commitment is already covered too) — this is
      // defense-in-depth against a claim the filter's ~1-tick-old view
      // could have missed, not the primary guard. Skip this candidate,
      // don't abort the whole pass, if it fails.
      if (!this.shipRegistry.claim(sym, "keeper", "keeper")) {
        this.log(`role: keeper conversion skipped for ${sym} — claimed by ${this.shipRegistry.ownerOf(sym)?.owner}`);
        continue;
      }
      // Stop the old loop so it doesn't keep mining/touring while the keeper
      // agent takes over the same ship.
      agent.stop();
      this.miners.delete(sym);
      this.tours.delete(sym);
      const keeper = new ShipAgent(agent.getShip(), {
        api: this.api,
        shouldRun: () => !this.paused,
        log: (m) => this.log(`${sym}: ${m}`),
        recordLedger: this.recordLedger,
        onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${sym} ${detail}`, credits),
        recordMarket: (wp) => this.recordMarketSnapshot(wp),
        isMarketWaypoint: (wp) => this.isMarketWaypoint(wp),
        recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
        keeperMarket: () => this.keeperMarkets.get(sym),
        getCredits: () => this.spendableCredits(),
      }).withWorld(this.positions, this.markets);
      this.keepers.set(sym, keeper);
      this.keeperMarkets.set(sym, market);
      if (this.tenantId) await this.store?.setFleetState(this.tenantId, sym, "keeper", market);
      this.log(`role: keeper ${sym} (converted from ${what}, stationed at ${market})`);
      if (this.scheduler) {
        // Cutover: `sym` is already in `scheduledShips` from its old role,
        // so syncSchedulerTasks()'s generic "is this ship new" check would
        // skip it here — the old agent's task chain just terminated itself
        // (stop() above set its running=false), and nothing would replace
        // it without this explicit enqueue. Directly give the new keeper
        // agent its first task, the same way the old-loop branch below
        // directly starts keeperLoop() for the same reason.
        keeper.running = true;
        this.scheduler.enqueue(keeper.nextKeeperTask());
      } else {
        // Launch the keeper loop now — the run() loop array was built at
        // startup, so a mid-run conversion needs its own loop.
        void keeper.keeperLoop(1_000_000);
      }
    }
  }

  /** Nearest known shipyard in `systemSymbol` — first found, not distance-
   *  ranked (mirrors installComponent()'s own yard lookup); cross-system
   *  shipyard search isn't attempted, same simplification rescue's tender
   *  planning makes for markets. */
  private nearestShipyard(systemSymbol: string): string | undefined {
    const known = this.galaxy.getSystem(systemSymbol);
    return known?.waypoints.find((w) => w.traits.some((t) => t.symbol === "SHIPYARD"))?.symbol;
  }

  /**
   * Repair opportunistically (a ship already docked at a shipyard for any
   * other reason, condition below the doctrine floor — just do it, no
   * detour) and, for a critically low ship, actively divert it to the
   * nearest known shipyard rather than waiting for it to happen to dock
   * somewhere — see doctrine.ts's CRITICAL_CONDITION comment for why that
   * second threshold isn't a tunable dial. The critical path claims through
   * ShipRegistry the same way makeRescuePlan() does, so it can't collide
   * with a mission/rescue/operator hold already using the ship — grabbing
   * it without that claim is exactly the partial-handback pattern behind
   * every bug docs/ship-control-state-audit.md catalogued.
   */
  private async maybeRepairFleet(): Promise<void> {
    const floor = this.doctrine.value("repairConditionFloor", 0);
    const available = this.availableFor("repair");
    for (const s of this.getShipStatuses()) {
      if (s.role === "idle" || s.role === "warehouse") continue;
      const ship = this.shipFor(s.symbol);
      if (!ship) continue;
      const worst = this.worstCondition(ship);
      if (worst >= floor) continue;
      if (ship.nav.status === "DOCKED" && (await this.isShipyard(ship.nav.systemSymbol, ship.nav.waypointSymbol))) {
        try {
          await this.repairShip(s.symbol);
        } catch (err) {
          this.log(`opportunistic repair for ${s.symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      if (worst >= CRITICAL_CONDITION) continue;
      if (this.repairPlans.has(s.symbol) || !available.has(s.symbol)) continue;
      const yard = this.nearestShipyard(ship.nav.systemSymbol);
      if (!yard) continue;
      if (!this.shipRegistry.claim(s.symbol, "repair", this.roleOf(s.symbol))) continue;
      this.repairPlans.add(s.symbol);
      this.log(`${s.symbol}: condition ${worst.toFixed(2)} critical — diverting to ${yard} for repair`);
      void this.runCriticalRepair(s.symbol, yard).finally(() => this.repairPlans.delete(s.symbol));
    }
  }

  /** Fire-and-forget: suspend the ship's own loop, fly it to the shipyard
   *  (raw API via dispatchShipHop, same mechanism mission carriers use, so
   *  a ship out of single-hop range still gets there), repair, hand back.
   *  Never awaited by maybeRepairFleet() itself — a multi-leg trip can take
   *  minutes, and the coordinator tick must not block on it. */
  private async runCriticalRepair(shipSymbol: string, yardSymbol: string): Promise<void> {
    await this.controlledAgent(shipSymbol)?.suspend();
    try {
      await this.dispatchShipHop(shipSymbol, yardSymbol);
      await this.repairShip(shipSymbol);
    } catch (err) {
      this.log(`critical repair dispatch for ${shipSymbol} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.releaseTo(shipSymbol, "repair");
    }
  }

  /** Whether keepers should cover the entire configured list regardless of the
   *  keeperCount cap. Persisted as a fleet flag, toggled from the dashboard. */
  async keeperCoverList(): Promise<boolean> {
    const raw = this.tenantId ? await this.store?.getFleetFlag(this.tenantId, "keeperCoverList") : undefined;
    if (raw === undefined) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return false;
    }
  }

  async setKeeperCoverList(value: boolean): Promise<void> {
    if (this.tenantId) await this.store?.setFleetFlag(this.tenantId, "keeperCoverList", JSON.stringify(value));
  }

  /** Priority markets from the configured list that no keeper currently covers. */
  private async priorityUncovered(): Promise<string[]> {
    const covered = new Set(this.keeperMarkets.values());
    return (await this.keeperPriorityMarkets()).filter((m) => !covered.has(m));
  }

  /** Ordered list of buy markets to station keepers at. Stored as a JSON flag
   *  so the dashboard can edit it; falls back to the built-in default. */
  async keeperPriorityMarkets(): Promise<string[]> {
    const raw = this.tenantId ? await this.store?.getFleetFlag(this.tenantId, "keeperMarkets") : undefined;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((m) => typeof m === "string")) return parsed as string[];
      } catch {
        // fall through to the default
      }
    }
    const def = [...DEFAULT_KEEPER_MARKETS];
    if (this.tenantId) await this.store?.setFleetFlag(this.tenantId, "keeperMarkets", JSON.stringify(def));
    return def;
  }

  /** Replace the keeper priority list. Returns the cleaned list actually stored. */
  async setKeeperPriorityMarkets(markets: string[]): Promise<string[]> {
    const clean = [...new Set(markets.map((m) => m.trim().toUpperCase()).filter((m) => m.length > 0))];
    if (this.tenantId) await this.store?.setFleetFlag(this.tenantId, "keeperMarkets", JSON.stringify(clean));
    return clean;
  }

  /** Drop the override and fall back to the built-in default list. */
  async resetKeeperPriorityMarkets(): Promise<string[]> {
    if (this.tenantId) await this.store?.removeFleetFlag(this.tenantId, "keeperMarkets");
    return this.keeperPriorityMarkets();
  }

  /** Current keeper stations for the dashboard: ship → market it guards. */
  keeperStations(): { shipSymbol: string; market: string }[] {
    return [...this.keeperMarkets.entries()].map(([shipSymbol, market]) => ({ shipSymbol, market }));
  }

  /** Attempt to rescue ships stranded at 0 fuel, first from their own cargo hold,
   *  then by dispatching a fuel tender to ferry FUEL to them. */
  private async rescueStranded(): Promise<void> {
    const stranded = this.getStrandedShips();
    // A ship no longer on the stranded list recovered some other way (the
    // trader's own stranded flag self-clears once it has real fuel again —
    // see TraderAgent.tick() — or a miner's live fuel check simply stopped
    // matching). Drop any stale failure reason so it can't resurface if the
    // ship strands again later for a genuinely different reason.
    const strandedSymbols = new Set(stranded.map((s) => s.symbol));
    for (const sym of [...this.rescueFailures.keys()]) if (!strandedSymbols.has(sym)) this.rescueFailures.delete(sym);
    for (const s of stranded) {
      try {
        const ship = await this.api.getShip(s.symbol);
        const fuelInCargo = ship.cargo.inventory?.find((i) => i.symbol === "FUEL");
        if (fuelInCargo && fuelInCargo.units > 0) {
          this.log(`rescuing ${s.symbol}: refueling from cargo (${fuelInCargo.units}u FUEL)`);
          await this.api.refuelShip(s.symbol, undefined, true);
          this.onActivity?.("refuel", `${s.symbol} rescued: refueled from cargo hold`, 0);
          continue;
        }
      } catch (err) {
        this.log(`rescue ${s.symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      await this.tenderRescueStep(s);
    }
  }

  /**
   * Find a tender that can reach the nearest market to the stranded ship, and plan the ferry.
   *
   * Every early-return here also records into `rescueFailures` — this used
   * to only `this.log(...)` the reason, which meant a ship that genuinely
   * had no viable tender anywhere in the fleet (every candidate's tank too
   * small, or mid-transit, or nothing with cargo room) failed silently,
   * every ~2s, forever: the dashboard's stranded banner just said
   * "stranded" with no way to tell "rescue is coming" from "rescue will
   * never come without you stepping in" — which is exactly the gap that
   * left a ship stranded for hours with no visible explanation.
   */
  private async makeRescuePlan(s: { symbol: string; waypointSymbol: string; fuel: number }): Promise<TenderPlan | undefined> {
    const systemSymbol = s.waypointSymbol.slice(0, s.waypointSymbol.lastIndexOf("-"));
    const known = this.galaxy.getSystem(systemSymbol);

    // Market candidates: any waypoint with a MARKETPLACE trait (known even before survey),
    // plus surveyed snapshots in memory AND in the store DB. Nearest to the stranded ship first.
    const marketSymbols = new Set<string>(this.markets.filter((m) => m.systemSymbol === systemSymbol).map((m) => m.symbol));
    const snapshotRows = (await this.store?.latestMarketSnapshots())?.filter((r) => r.systemSymbol === systemSymbol) ?? [];
    for (const r of snapshotRows) {
      marketSymbols.add(r.waypointSymbol);
    }
    for (const w of known?.waypoints ?? []) {
      if (w.traits.some((t) => t.symbol === "MARKETPLACE")) marketSymbols.add(w.symbol);
    }
    // RLC8989-4's agent discovers markets via observeMarket and keeps its own list, but the
    // coordinator may not have them yet; store is the most reliable source.
    const markets = [...marketSymbols]
      .map((sym) => ({ sym, dist: this.estimatedFuelBetween(s.waypointSymbol, sym) }))
      .sort((a, b) => a.dist - b.dist);
    if (markets.length === 0) {
      const reason = `no known market in ${systemSymbol} to source fuel from`;
      this.log(`no fuel tender possible for ${s.symbol}: ${reason}`);
      this.rescueFailures.set(s.symbol, reason);
      return undefined;
    }
    const strandedCap = this.cachedShip(s.symbol)?.fuel.capacity ?? 20;

    // Find a parked ship in the same system (most fuel first) that can actually get to a market.
    // availableFor("rescue") replaces a bare !isManual() check here — that
    // check alone never excluded an *isSuspended()* ship (already tendering
    // for a different rescue, or a mission carrier mid-flight), so either
    // could have been picked as a second tender out from under whatever
    // already had it. See docs/ship-control-state-audit.md, Phase 2.
    const available = this.availableFor("rescue");
    const candidates = [...this.miners.entries(), ...this.traders.entries()]
      .filter(([sym]) => available.has(sym))
      .map(([sym, a]) => ({ sym, ship: a.getShip() as Ship }))
      .concat(
        [...this.idleShips.entries()]
          .filter(([sym]) => available.has(sym))
          .map(([sym, ship]) => ({ sym, ship })),
      )
      .filter(({ sym, ship }) => {
        if (sym === s.symbol) return false;
        if (ship.nav.status === "IN_TRANSIT") return false;
        if (ship.nav.waypointSymbol === s.waypointSymbol) return false;
        // A ship with a full cargo hold can't buy any FUEL to ferry — same
        // failure mode as having no cargo hold at all, just discovered later
        // (mid-rescue, as a purchaseCargo "exceeds max limit" error) instead of
        // up front. Reject it here so a full ship is never picked as a tender.
        if (ship.cargo.capacity - ship.cargo.units <= 0) return false;
        return true;
      })
      .sort((a, b) => b.ship.fuel.current - a.ship.fuel.current);

    let tender: { sym: string; ship: Ship } | undefined;
    let market: { sym: string; dist: number } | undefined;
    // Rank by total journey cost: distance from the tender to a market, plus that market's
    // distance to the stranded ship. A ship already near the stranded (e.g. RLC8989-4 at E50,
    // a hop from market E47) beats a distant ship parked at a far market (RLC8989-5 at FX5Z).
    const ranked = [...candidates]
      .map((c) => {
        const atMarketIdx = markets.findIndex((m) => m.sym === c.ship.nav.waypointSymbol);
        const near = markets[atMarketIdx >= 0 ? atMarketIdx : 0];
        const toMarket = this.estimatedFuelBetween(c.ship.nav.waypointSymbol, near!.sym);
        const fromMarket = near!.dist;
        return { ...c, toMarket: Number.isFinite(toMarket) ? toMarket : Infinity, fromMarket: Number.isFinite(fromMarket) ? fromMarket : Infinity };
      })
      .sort((a, b) => a.toMarket + a.fromMarket - (b.toMarket + b.fromMarket) || b.ship.fuel.current - a.ship.fuel.current);
    for (const cand of ranked) {
      // Prefer loading at the tender's current waypoint if it's already a market, else the
      // market nearest the stranded ship.
      const nearestIdx = markets.findIndex((m) => m.sym === cand.ship.nav.waypointSymbol);
      const nearest = markets[nearestIdx >= 0 ? nearestIdx : 0];
      const fuelToMarket = this.estimatedFuelBetween(cand.ship.nav.waypointSymbol, nearest!.sym);
      if (cand.ship.fuel.capacity > 0 && cand.ship.fuel.current < fuelToMarket) {
        this.log(`tender ${cand.sym} cannot reach market ${nearest!.sym} (need ${fuelToMarket} fuel, has ${cand.ship.fuel.current})`);
        continue; // try the next candidate instead of abandoning the rescue
      }
      // The tender must also be able to make the loaded leg from the market to
      // the stranded ship. Tank capacity bounds a single leg — loading fuel
      // doesn't extend range, so a small tank can't ferry to a far ship even if
      // it can reach a nearby market.
      if (cand.ship.fuel.capacity > 0 && cand.ship.fuel.capacity < nearest!.dist) {
        this.log(`tender ${cand.sym} tank too small for ${nearest!.sym}->${s.waypointSymbol} (need ${nearest!.dist} fuel, cap ${cand.ship.fuel.capacity})`);
        continue;
      }
      tender = cand;
      market = nearest!;
      break;
    }
    if (!tender || !market) {
      const reason = candidates.length === 0
        ? "no other ship free to tender (all are manual, in transit, at the same waypoint, or have no cargo hold)"
        : "no candidate ship can make the round trip (not enough fuel, or tank too small for the distance)";
      this.log(`no fuel tender available for ${s.symbol} in ${systemSymbol}: ${reason}`);
      this.rescueFailures.set(s.symbol, reason);
      return undefined;
    }
    this.rescueFailures.delete(s.symbol);
    // Count any FUEL the tender is already hauling, so an interrupted rescue can resume
    // without needing cargo room to re-buy.
    const heldFuel = tender.ship.cargo.inventory?.find((i) => i.symbol === "FUEL")?.units ?? 0;
    const cargoFree = tender.ship.cargo.capacity - tender.ship.cargo.units;
    // Size the delivery to what the stranded needs to limp to the nearest market, not its
    // whole tank. Reserve covers the hop plus a safety margin.
    const fuelNeeded = this.estimatedFuelBetween(s.waypointSymbol, market.sym) + 6;
    const fuelUnits = Math.max(
      1,
      Math.min(strandedCap, fuelNeeded, heldFuel + cargoFree),
    );

    // Suspend the tender's agent so it holds position and doesn't fight the rescue.
    // Awaited: stepRescue() starts mutating the tender's nav state directly via
    // the raw API on the very next coordinator tick, so a tick already in flight
    // for this ship must finish first or it can race that mutation against its
    // own stale cached ship state ("not currently docked" errors).
    const miner = this.miners.get(tender.sym);
    const trader = this.traders.get(tender.sym);
    if (miner) { await miner.suspend(); } else if (trader) { await trader.suspend(); }
    // Claim through the registry too, not just suspend() (Phase 2) — the
    // candidate was already filtered through availableFor("rescue") above,
    // so this should always succeed; logged rather than aborted if it
    // somehow doesn't, since the tender is already suspended and mid-plan by
    // this point and abandoning here would leave it stuck for no benefit.
    if (!this.shipRegistry.claim(tender.sym, "rescue", this.roleOf(tender.sym))) {
      this.log(`rescue tender ${tender.sym}: registry claim unexpectedly lost to ${this.shipRegistry.ownerOf(tender.sym)?.owner} — proceeding anyway, already suspended`);
    }

    this.log(`dispatching fuel tender ${tender.sym} to rescue ${s.symbol}: buy ${Math.max(0, fuelUnits - heldFuel)}u FUEL at ${market.sym} (${heldFuel}u already held), fly to ${s.waypointSymbol}`);
    return {
      strandedSymbol: s.symbol,
      strandedWaypoint: s.waypointSymbol,
      tenderSymbol: tender.sym,
      market: market.sym,
      fuelUnits,
      // Skip the buy step entirely if the tender is already hauling enough fuel.
      phase: heldFuel >= fuelUnits ? "transit" : "buy",
    };
  }

  private async tenderRescueStep(s: { symbol: string; waypointSymbol: string; fuel: number }): Promise<void> {
    let plan = this.rescuePlans.get(s.symbol);
    if (!plan) {
      plan = await this.makeRescuePlan(s);
      if (plan) this.rescuePlans.set(s.symbol, plan);
      if (!plan) return;
    }
    try {
      await this.stepRescue(plan);
      this.rescueStepFailures.delete(s.symbol);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failures = (this.rescueStepFailures.get(s.symbol) ?? 0) + 1;
      if (failures >= 3) {
        // This plan is broken (not just unlucky) — give up on it rather than
        // retrying the identical failing step forever (the actual deadlock:
        // a full-cargo tender's buy step throws every single time, and
        // nothing previously ever dropped the plan except phase==="done").
        // Release the tender and drop the plan so the next rescue cycle
        // calls makeRescuePlan() fresh, which (with Fix 1) will skip this
        // tender and try a different one.
        this.log(`rescue for ${s.symbol}: abandoning tender ${plan.tenderSymbol} after ${failures} failed attempts (${msg})`);
        this.rescueFailures.set(s.symbol, `tender ${plan.tenderSymbol} failed repeatedly: ${msg}`);
        this.rescuePlans.delete(s.symbol);
        this.rescueStepFailures.delete(s.symbol);
        // releaseTo() looks the ship up via controlledAgent() (every role
        // map, not just miner/trader — a tender suspended under one role
        // that the dispatcher then reassigns mid-rescue, confirmed live: a
        // miner pulled into fuel-trading duty, was found in neither map
        // here before this, so it never got resumed at all) and clears
        // resume/release/dispatcher/registry/manual-state together.
        await this.releaseTo(plan.tenderSymbol, "rescue");
      } else {
        this.rescueStepFailures.set(s.symbol, failures);
        this.log(`rescue step for ${s.symbol} failed (attempt ${failures}/3, tender ${plan.tenderSymbol}): ${msg}`);
      }
      return;
    }
    if (plan.phase === "done") {
      this.rescuePlans.delete(s.symbol);
      // Same as the abandonment path above.
      await this.releaseTo(plan.tenderSymbol, "rescue");
    }
  }

  /** Advance one rescue phase per coordinator tick (never blocks on transit). */
  private async stepRescue(plan: TenderPlan): Promise<void> {
    const tender = await this.api.getShip(plan.tenderSymbol);
    if (tender.nav.status === "IN_TRANSIT") return;

    if (plan.phase === "buy") {
      if (tender.nav.waypointSymbol !== plan.market) {
        if (tender.nav.status === "DOCKED") await this.api.orbitShip(plan.tenderSymbol);
        await this.api.navigateShip(plan.tenderSymbol, plan.market);
        this.log(`tender ${plan.tenderSymbol}: flying to ${plan.market} to load FUEL`);
        return;
      }
      if (tender.nav.status === "IN_ORBIT") await this.api.dockShip(plan.tenderSymbol);
      // Top off the tank so the tender can actually make the trip to the stranded ship.
      if (tender.fuel.capacity > 0 && tender.fuel.current < tender.fuel.capacity) {
        await this.api.refuelShip(plan.tenderSymbol);
      }
      const held = tender.cargo.inventory?.find((i) => i.symbol === "FUEL")?.units ?? 0;
      const toBuy = Math.max(0, plan.fuelUnits - held);
      if (toBuy > 0) {
        // FUEL is exempt from canAfford() fleet-wide (see buyCargo()'s same
        // exemption) — a stranded ship's recovery cost matters more than the
        // cash floor's strategic reserve.
        const res = await this.api.purchaseCargo(plan.tenderSymbol, "FUEL", toBuy);
        this.log(`tender ${plan.tenderSymbol}: loaded ${res.transaction.units}u FUEL @ ${res.transaction.pricePerUnit}c`);
      } else {
        this.log(`tender ${plan.tenderSymbol}: already holding ${held}u FUEL, skipping buy`);
      }
      plan.phase = "transit";
      return;
    }

    if (plan.phase === "transit") {
      if (tender.nav.waypointSymbol !== plan.strandedWaypoint) {
        await this.api.orbitShip(plan.tenderSymbol);
        await this.api.navigateShip(plan.tenderSymbol, plan.strandedWaypoint);
        this.log(`tender ${plan.tenderSymbol}: en route to ${plan.strandedWaypoint} with ${plan.fuelUnits}u FUEL`);
        return;
      }
      plan.phase = "transfer";
    }

    if (plan.phase === "transfer") {
      // Both ships must be at the same waypoint AND in the same dock state
      // (both docked or both in orbit) for cargo transfer to work.
      const stranded = await this.api.getShip(plan.strandedSymbol);
      if (stranded.nav.waypointSymbol !== tender.nav.waypointSymbol) {
        this.log(`tender ${plan.tenderSymbol}: ${tender.nav.waypointSymbol} != stranded ${stranded.nav.waypointSymbol}; returning to buy phase`);
        plan.phase = "buy";
        return;
      }
      if (stranded.nav.status !== tender.nav.status) {
        this.log(`tender ${plan.tenderSymbol}: aligning dock state (${tender.nav.status} vs ${stranded.nav.status})`);
        if (stranded.nav.status === "DOCKED" && tender.nav.status === "IN_ORBIT") {
          await this.api.dockShip(plan.tenderSymbol);
        } else if (stranded.nav.status === "IN_ORBIT" && tender.nav.status === "DOCKED") {
          await this.api.orbitShip(plan.tenderSymbol);
        }
      }
      // The stranded ship must have cargo room to receive the fuel. If it's carrying ore,
      // jettison just enough to fit (the stranded can't use the ore while out of fuel anyway).
      const fresh = await this.api.getShip(plan.strandedSymbol);
      const freeSpace = fresh.cargo.capacity - fresh.cargo.units;
      if (freeSpace < plan.fuelUnits) {
        const overflow = plan.fuelUnits - freeSpace;
        let toDump = overflow;
        for (const item of [...fresh.cargo.inventory]) {
          if (toDump <= 0) break;
          if (item.symbol === "FUEL") continue;
          const drop = Math.min(toDump, item.units);
          await this.api.jettisonCargo(plan.strandedSymbol, item.symbol, drop);
          toDump -= drop;
        }
        this.log(`tender ${plan.tenderSymbol}: jettisoned ${overflow - toDump}u ore from ${plan.strandedSymbol} to make room for fuel`);
      }
      await this.api.transferCargo(plan.tenderSymbol, "FUEL", plan.fuelUnits, plan.strandedSymbol);
      const refueled = await this.api.refuelShip(plan.strandedSymbol, undefined, true);
      this.log(`tender ${plan.tenderSymbol}: transferred ${plan.fuelUnits}u FUEL to ${plan.strandedSymbol}; stranded refueled to ${refueled.fuel.current}/${refueled.fuel.capacity}`);
      this.onActivity?.("refuel", `${plan.strandedSymbol} rescued: fuel tender delivered ${plan.fuelUnits}u FUEL`, 0);
      // Clear the stranded flag so the ship can resume autonomous trading.
      this.traders.get(plan.strandedSymbol)?.clearStranded();
      this.miners.get(plan.strandedSymbol)?.clearStranded();
      plan.phase = "done";
    }
  }

  /** Distance (≈ fuel) between two waypoints using the atlas. */
  private estimatedFuelBetween(a: string, b: string): number {
    const pa = this.positions.find((p) => p.symbol === a);
    const pb = this.positions.find((p) => p.symbol === b);
    if (!pa || !pb) return Infinity;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
  }

  private async autoExplore(): Promise<void> {
    // Survey connected systems occasionally, sending an idle trader to scout them.
    const knownSystems = this.galaxy.listSystems().map((s) => s.symbol);
    // Reachable *right now*, not just topologically connected: a system whose
    // only known connection is via a still-under-construction gate is
    // filtered out here on every pass, via the live canJump() cache, rather
    // than being blacklisted forever after one failed attempt (the previous
    // design's gateBlockedSystems set was write-only — nothing ever cleared
    // it, so a system whose gate finished construction *after* one failed
    // attempt stayed excluded permanently, silently, with no separate
    // "unblock" step to notice). Once construction completes, the very next
    // pass picks the system back up on its own.
    const reachable = new Set<string>();
    for (const s of knownSystems) {
      for (const c of this.galaxy.connectedSystems(s)) {
        if (this.galaxy.canJump(s, c)) reachable.add(c);
      }
    }
    const unsurveyed = [...reachable].filter((c) => !this.surveyedSystems.has(c));
    const now = Date.now();
    // Only attempt exploration at most once every 10 minutes. The set above is
    // just a cheap "is there anything left to explore anywhere" short-circuit —
    // it says nothing about whether any particular scout can get there, which
    // is decided per scout below.
    if (unsurveyed.length === 0 || now - this.lastExploreTick < 600_000) return;

    // Every idle dedicated intel ship (tour shuttle / chart scout), ONLY.
    // Money-making traders and miners must never be pulled off their routes
    // to scout — exploration is opportunistic, not worth interrupting a
    // trade cycle for.
    const idle = (a: { isManual(): boolean; getShip(): components["schemas"]["Ship"] }) =>
      !a.isManual() && a.getShip().cargo.units === 0;
    const rank = (fuel: number) => -fuel; // more fuel = better for a long jump
    type ScoutCandidate = { s: string; a: { isManual(): boolean; getShip(): components["schemas"]["Ship"] }; fuel: number };
    const dedicated: ScoutCandidate[] = [
      ...[...this.tours.entries()].map(([s, a]) => ({ s, a, fuel: a.getShip().fuel.capacity })),
      ...[...this.scouts.entries()].map(([s, a]) => ({ s, a, fuel: a.getShip().fuel.capacity })),
    ]
      // Never pull a ship whose role was deliberately overridden (manual role,
      // operator hold) off its assigned job to scout — same protection the
      // promotion and keeper logic already give them.
      .filter((c) => !this.manualRoleShips.has(c.s) && !c.a.isManual())
      .filter((c) => idle(c.a))
      .sort((a, b) => rank(a.fuel) - rank(b.fuel));
    if (dedicated.length === 0) return;

    // Pair each idle scout with a distinct unsurveyed system it can actually
    // jump to *from where it is standing right now*.
    //
    // This used to pair scout `i` with target `i` out of a shuffled list of
    // every unsurveyed system reachable from anywhere we know — a set that says
    // "some system we have charted has a working gate to this" and nothing
    // about the scout being sent. exploreSystem() then applies the real test
    // (gatesTo() from the ship's own current system) and throws
    // "no jump gate to X" before the ship moves an inch. Seen live: a scout
    // parked in TP98 was handed TV75, which only neighbours home, and failed
    // 2 seconds later; the catch below logs and gives up for the pass, so the
    // ship burns a whole 10-minute window doing nothing, and the next pass can
    // deal it the same impossible target again.
    //
    // Choosing randomly among a scout's own options preserves the property the
    // old shuffle was there for: a target that keeps failing for a reason we
    // can't see from here can't monopolize the same scout pass after pass.
    const taken = new Set<string>();
    const pairs: { scout: ScoutCandidate; target: string }[] = [];
    for (const scout of dedicated) {
      const from = scout.a.getShip().nav.systemSymbol;
      const options = this.galaxy
        .connectedSystems(from)
        .filter((c) => !this.surveyedSystems.has(c) && !taken.has(c) && this.galaxy.canJump(from, c));
      const target = options[Math.floor(Math.random() * options.length)];
      if (!target) continue; // nothing this scout can reach from here
      taken.add(target);
      pairs.push({ scout, target });
    }
    // Don't burn the 10-minute window when every idle scout is somewhere with
    // no reachable frontier — that would just idle them until one happens to be
    // moved. Retrying costs a few in-memory cache reads.
    if (pairs.length === 0) return;
    this.lastExploreTick = now;

    await Promise.allSettled(
      pairs.map(async ({ scout, target }) => {
        try {
          this.log(`auto-exploring ${target} with ${scout.s} (${scout.fuel} fuel)`);
          await this.exploreSystem(scout.s, target);
          this.surveyedSystems.add(target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`auto-explore ${target} failed: ${msg}`);
          // Deliberately NOT marked surveyed here, for any failure reason: a
          // transient error should be retried on a later pass (throttled the
          // same 10 minutes as every other attempt), not excluded forever. A
          // gate under construction is already filtered out of `reachable`
          // above and needs no separate tracking here.
        }
      }),
    );
  }

  /** Drive every ship and the coordination loop. */
  async run(maxTicks: number): Promise<void> {
    this.running = true;
    // Cutover: with a scheduler, every agent is driven by nextTask() chains
    // enqueued via syncSchedulerTasks() (called from tick(), including once
    // at the end of init()) — none of the old blocking loops are started at
    // all. Without one (the default for any caller not yet updated), fall
    // back to starting them exactly as before. See FleetOptions.scheduler's
    // comment.
    const loops: Promise<void>[] = this.scheduler
      ? []
      : [
          ...[...this.miners.values()].map((a) => a.runLoop(maxTicks)),
          ...[...this.traders.values()].map((a) => a.runLoop(maxTicks)),
          ...[...this.surveyors.values()].map((a) => a.surveyLoop(maxTicks)),
          ...[...this.tours.values()].map((a) => a.tourLoop(maxTicks)),
          ...[...this.keepers.values()].map((a) => a.keeperLoop(maxTicks)),
          ...[...this.scouts.values()].map((a) => a.runLoop(maxTicks)),
          ...[...this.siphoners.values()].map((a) => a.runLoop(maxTicks)),
        ];
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      try {
        await this.tick();
      } catch (err) {
        this.log(`coordinator error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(2_000);
    }
    this.running = false;
    await Promise.allSettled(loops);
  }

  stop(): void {
    this.running = false;
  }
}
