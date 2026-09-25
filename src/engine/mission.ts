import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { Store } from "../db/store.js";

export type Construction = components["schemas"]["Construction"];
export type Ship = components["schemas"]["Ship"];

/** A single required material tracked toward completion. */
export interface MissionMaterial {
  tradeSymbol: string;
  required: number;
  fulfilled: number;
}

export type MissionKind = "SUPPLY_CONSTRUCTION";

/**
 * A task the fleet has committed to: deliver enough of each material to a
 * construction site (e.g. a jump gate) until the site reports complete.
 *
 * `assignedShips`/`carrierTarget` replaced the old singular `assignedShip`
 * so a bottleneck material can be worked by more than one ship at once (the
 * "protocol" ramp-up — see CLAUDE.md/docs/TODO.md). `carrierTarget` is how
 * many ships this mission wants staffed; the engine auto-picks one more per
 * tick (same throttled ramp-up as the old single-carrier auto-pick) until
 * `assignedShips.length` reaches it. Defaulting `carrierTarget` to 1
 * preserves today's single-carrier behavior for every mission that never
 * touches the new crew-size controls.
 */
export interface Mission {
  kind: MissionKind;
  targetSystem: string;
  targetWaypoint: string;
  status: "active" | "complete";
  assignedShips: string[];
  carrierTarget: number;
  materials: MissionMaterial[];
  /** True while the operator has this mission held (no sourcing, no spending). */
  paused?: boolean;
}

interface MissionOptions {
  api: SpaceTradersAPI;
  store?: Store;
  /** Bound once, like Doctrine — see src/engine/doctrine.ts's class doc comment
   *  for why: this instance belongs to exactly one tenant for its whole
   *  lifetime, so nothing above MissionManager has to thread tenantId through
   *  every call site. */
  tenantId?: string;
  log?: (msg: string) => void;
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Record a real credits-moving transaction to the ledger. Confirmed live:
   *  stepCarrier()'s material buy used to call this.api.purchaseCargo()
   *  directly, bypassing this entirely — every mission purchase was invisible
   *  to ledger-based reconciliation, discoverable only via ephemeral Render
   *  logs. Same shape as every other engine class's recordLedger option
   *  (trader.ts, feed.ts, etc.) so fleet.ts can wire this.recordLedger
   *  straight through, same as it already does for those. */
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "PURCHASE" | "SELL" | "REFUEL";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
    realizedPnl?: number;
  }) => void;
  /** Resolve current position/fuel for a ship. */
  getShip?: (symbol: string) => Promise<Ship>;
  /** Estimate fuel between two waypoints. */
  estimatedFuelBetween?: (a: string, b: string) => number;
  /** True if a ship can physically reach the mission target (directly or via refuel stops). */
  canReach?: (shipSymbol: string, targetWaypoint: string) => Promise<boolean>;
  /** Fly a ship to a waypoint (any system), returning when it arrives/docked. */
  dispatchShip?: (shipSymbol: string, waypointSymbol: string) => Promise<void>;
  /** Pick an idle cargo-capable ship to run this mission. */
  pickCarrier?: (exclude: Set<string>, targetWaypoint?: string) => Promise<string | undefined>;
  /**
   * Suspend/resume a ship's autonomous agent while it works the mission.
   * `suspend` resolves once any loop iteration already in flight for that
   * ship has finished — callers must await it before mutating the ship's nav
   * state directly (via `dispatchShip`), or risk racing a tick that's still
   * mid-flight against stale cached ship state ("not currently docked" errors).
   */
  suspend?: (shipSymbol: string) => void | Promise<void>;
  resume?: (shipSymbol: string) => void;
  /** Sources known to sell a trade good in the given system, cheapest first:
   *  { waypoint, purchasePrice, tradeVolume }. System-scoped, not
   *  galaxy-wide — confirmed live: an unscoped lookup once returned a
   *  cheaper listing from a system with no jump gate connection to the
   *  mission's own, and the carrier tried (and failed) to route there every
   *  tick forever. A carrier can only ever reasonably reach a market in the
   *  mission's own system, or one connected to it — starting with just the
   *  mission's own system is the safe, minimal fix. */
  listBuyers?: (tradeSymbol: string, systemSymbol: string) => Promise<{ waypoint: string; purchasePrice: number; tradeVolume: number }[]>;
  /** Survey a small batch of unknown markets in the given system looking for the good; returns newly found buyers. */
  discoverBuyers?: (tradeSymbol: string, systemSymbol: string) => Promise<{ waypoint: string; purchasePrice: number }[]>;
  /** Credits available to spend on mission supplies. */
  getCredits?: () => Promise<number>;
  /** Sell cargo for a ship (used to free space / top up credits). */
  sellCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
  jettisonCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a *paused* mission re-reads its construction site. See `tick`. */
const PAUSED_RECONCILE_MS = 60_000;

/**
 * Coordinates fleet missions: assigns a carrier ship to a construction site,
 * sources the required materials from known markets, ferries them, and reports
 * progress. One step per call (each coordinator tick), never blocking on transit.
 *
 * Ported from straders' src/engine/mission.ts with one shape change beyond
 * async/await: `list()`, `assignCarrier()`, `pause()`, and `resumeMission()`
 * were synchronous there (SQLite's `Store.recordMission`/`latestMissions`
 * were synchronous calls) — all four touch the store, directly or via
 * `persist()`, so all four are async here. Every caller of any of them
 * (fleet.ts, not yet ported into this repo) will need `await` added at the
 * same time fleet.ts itself gets converted.
 */
export class MissionManager {
  private readonly api: SpaceTradersAPI;
  private readonly store?: Store;
  private readonly tenantId?: string;
  private readonly log: (msg: string) => void;
  private readonly onActivity: MissionOptions["onActivity"];
  private readonly recordLedger?: MissionOptions["recordLedger"];
  private readonly getShip?: MissionOptions["getShip"];
  private readonly estimatedFuelBetween?: MissionOptions["estimatedFuelBetween"];
  private readonly canReach?: MissionOptions["canReach"];
  private readonly dispatchShip?: MissionOptions["dispatchShip"];
  private readonly pickCarrier?: MissionOptions["pickCarrier"];
  private readonly suspend?: MissionOptions["suspend"];
  private readonly resume?: MissionOptions["resume"];
  private readonly listBuyers?: MissionOptions["listBuyers"];
  private readonly discoverBuyers?: MissionOptions["discoverBuyers"];
  private readonly getCredits?: MissionOptions["getCredits"];
  private readonly sellCargo?: MissionOptions["sellCargo"];
  private readonly jettisonCargo?: MissionOptions["jettisonCargo"];

  private active = new Map<string, Mission>();
  /** Per-mission, per-ship transient state (not persisted): what each carrier
   *  is doing right now. Keyed by waypoint, then by that ship's own symbol —
   *  every carrier on a mission drives its own independent source→buy→supply
   *  loop, so each needs its own TaskState. */
  private tasks = new Map<string, Map<string, TaskState>>();
  /** Waypoint → when its progress was last reconciled against the live site.
   *  Paused missions reconcile on this slow cadence instead of every tick. */
  private lastReconcile = new Map<string, number>();
  /** Waypoints whose missions are paused (no sourcing/spending until resumed). */
  private paused = new Set<string>();
  /** Waypoint → next time step()'s pre-assignment discovery survey may run,
   *  for missions with no crew yet (so it's throttled the same way a real
   *  carrier's own maybeDiscover() call is, instead of firing every tick). */
  private preAssignDiscoverRetry = new Map<string, number>();

  constructor(opts: MissionOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.tenantId = opts.tenantId;
    this.log = opts.log ?? ((m) => console.log(`[mission] ${m}`));
    this.onActivity = opts.onActivity;
    this.recordLedger = opts.recordLedger;
    this.getShip = opts.getShip;
    this.estimatedFuelBetween = opts.estimatedFuelBetween;
    this.canReach = opts.canReach;
    this.dispatchShip = opts.dispatchShip;
    this.pickCarrier = opts.pickCarrier;
    this.suspend = opts.suspend;
    this.resume = opts.resume;
    this.listBuyers = opts.listBuyers;
    this.discoverBuyers = opts.discoverBuyers;
    this.getCredits = opts.getCredits;
    this.sellCargo = opts.sellCargo;
    this.jettisonCargo = opts.jettisonCargo;
  }

  /** Register a mission to build/complete a construction site. */
  async startConstruction(waypointSymbol: string, materials?: MissionMaterial[]): Promise<void> {
    const system = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (this.active.has(waypointSymbol)) return;
    const known = this.tenantId ? await this.store?.latestMissions(this.tenantId) : undefined;
    const persisted = known?.find((m) => m.targetWaypoint === waypointSymbol && m.status === "active");
    if (persisted) {
      // Resume an interrupted mission from persistent state.
      const mission: Mission = {
        kind: "SUPPLY_CONSTRUCTION",
        targetSystem: system,
        targetWaypoint: waypointSymbol,
        status: "active",
        materials: persisted.materials,
        assignedShips: [...persisted.assignedShips],
        carrierTarget: persisted.carrierTarget,
      };
      this.active.set(waypointSymbol, mission);
      if (persisted.paused) {
        // Stay paused across restarts — don't re-suspend the carrier or start sourcing.
        this.paused.add(waypointSymbol);
        this.log(`mission resumed (from prior state, PAUSED): supply ${waypointSymbol}`);
        return;
      }
      const shipTasks = new Map<string, TaskState>();
      for (const s of mission.assignedShips) {
        shipTasks.set(s, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
        await this.suspend?.(s);
      }
      this.tasks.set(waypointSymbol, shipTasks);
      this.log(`mission resumed (from prior state): supply ${waypointSymbol}`);
      return;
    }
    let mats = materials;
    if (!mats) {
      const c = await this.api.getConstruction(system, waypointSymbol);
      mats = c.materials.map((m) => ({ tradeSymbol: m.tradeSymbol, required: m.required, fulfilled: m.fulfilled }));
      if (c.isComplete) {
        this.log(`construction ${waypointSymbol} already complete`);
        if (this.tenantId) await this.store?.completeMission(this.tenantId, waypointSymbol);
        return;
      }
    }
    const mission: Mission = { kind: "SUPPLY_CONSTRUCTION", targetSystem: system, targetWaypoint: waypointSymbol, status: "active", materials: mats, assignedShips: [], carrierTarget: 1 };
    this.active.set(waypointSymbol, mission);
    this.tasks.set(waypointSymbol, new Map());
    await this.persist(mission);
    this.log(`mission started: supply ${waypointSymbol} (${mats.map((m) => `${m.tradeSymbol} ${m.fulfilled}/${m.required}`).join(", ")})`);
    this.onActivity?.("mission", `mission started: supply ${waypointSymbol}`, 0, undefined);
  }

  /** Full list of known missions, newest first. */
  async list(): Promise<Mission[]> {
    const rows = this.tenantId ? await this.store?.latestMissions(this.tenantId) : undefined;
    const persisted: Mission[] = (rows ?? []).map((m) => ({
      kind: m.kind,
      targetSystem: m.targetSystem,
      targetWaypoint: m.targetWaypoint,
      status: m.status,
      assignedShips: m.assignedShips,
      carrierTarget: m.carrierTarget,
      materials: m.materials,
      paused: m.paused,
    }));
    // this.paused is authoritative for anything already in this.active — the
    // operator can pause/resume between writes, and that in-memory Set is
    // exactly what pause()/resumeMission() maintain live. But a mission that
    // hasn't been loaded into this.active yet (the gap between process start
    // and init()'s mission-restore pass, or if that restore ever fails for
    // one waypoint) has no entry in this.paused either — falling back to
    // `false` there previously made a mission the operator explicitly paused
    // report as running again after every restart, which is exactly what was
    // reported live. The persisted row's own `paused` column is the correct
    // answer for that case, since it's exactly what pause() wrote.
    return [...this.active.values(), ...persisted.filter((p) => !this.active.has(p.targetWaypoint))]
      .map((m) => ({ ...m, paused: this.active.has(m.targetWaypoint) ? this.paused.has(m.targetWaypoint) : (m.paused ?? false) }));
  }

  /** Are any ships currently committed to missions? (fleet should not reassign them) */
  committedShips(): Set<string> {
    const out = new Set<string>();
    for (const m of this.active.values()) for (const s of m.assignedShips) out.add(s);
    return out;
  }

  /**
   * Trade symbols still needed by any active mission (not yet fully supplied).
   * The fleet must never sell, jettison, or arbitrage these — they are reserved
   * for the construction site.
   */
  protectedGoods(): Set<string> {
    const out = new Set<string>();
    for (const m of this.active.values()) {
      // A paused mission isn't sourcing anything, so its materials must not
      // block the traders — otherwise the fleet's best routes sit reserved
      // while the mission sits idle. (Observed: paused I59 hoarding the
      // ADVANCED_CIRCUITRY route worth 64k/trip.)
      if (this.paused.has(m.targetWaypoint)) continue;
      for (const mat of m.materials) {
        if (mat.fulfilled < mat.required) out.add(mat.tradeSymbol);
      }
    }
    return out;
  }

  /** Advance every active mission by one step. Call once per coordinator tick. */
  async tick(): Promise<void> {
    for (const mission of [...this.active.values()]) {
      if (this.paused.has(mission.targetWaypoint)) {
        // Paused missions don't source/spend, but still reconcile their progress
        // against the live construction site so the dashboard shows real numbers.
        //
        // On a slow cadence, though: this ran on every 2s coordinator tick, so
        // pausing a mission gave back no API budget at all — the one thing an
        // operator pausing a mission is most likely to want. A paused mission's
        // progress only changes if something outside this fleet supplies it.
        const last = this.lastReconcile.get(mission.targetWaypoint) ?? 0;
        if (Date.now() - last >= PAUSED_RECONCILE_MS) {
          this.lastReconcile.set(mission.targetWaypoint, Date.now());
          await this.reconcile(mission);
        }
        continue;
      }
      try {
        await this.step(mission);
      } catch (err) {
        this.log(`mission ${mission.targetWaypoint} step error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Refresh a mission's fulfilled counts from the authoritative construction state. */
  private async reconcile(mission: Mission): Promise<void> {
    try {
      const c = await this.api.getConstruction(mission.targetSystem, mission.targetWaypoint);
      let changed = false;
      for (const m of mission.materials) {
        const live = c.materials.find((x) => x.tradeSymbol === m.tradeSymbol);
        if (live && live.fulfilled !== m.fulfilled) {
          m.fulfilled = live.fulfilled;
          changed = true;
        }
      }
      if (changed) await this.persist(mission);
    } catch (err) {
      // ignore: construction may be temporarily unreachable
    }
  }

  /**
   * Add a ship to a mission's crew, bumping `carrierTarget` to at least the
   * new crew size if needed. Unlike the old single-carrier version, this
   * never replaces an existing carrier — it staffs alongside them. A no-op
   * if the ship is already on this mission's crew.
   */
  async assignCarrier(waypointSymbol: string, shipSymbol: string): Promise<void> {
    const mission = this.active.get(waypointSymbol);
    if (!mission) throw new Error(`no active mission at ${waypointSymbol}`);
    if (mission.assignedShips.includes(shipSymbol)) return;
    mission.assignedShips.push(shipSymbol);
    if (mission.carrierTarget < mission.assignedShips.length) mission.carrierTarget = mission.assignedShips.length;
    await this.suspend?.(shipSymbol);
    if (!this.paused.has(waypointSymbol)) {
      const shipTasks = this.tasks.get(waypointSymbol) ?? new Map<string, TaskState>();
      shipTasks.set(shipSymbol, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
      this.tasks.set(waypointSymbol, shipTasks);
    }
    await this.persist(mission);
    this.log(`mission ${waypointSymbol}: ${shipSymbol} added to crew (${mission.assignedShips.length}/${mission.carrierTarget})`);
    this.onActivity?.("mission", `${shipSymbol} assigned to ${waypointSymbol} by operator`, 0, shipSymbol);
  }

  /**
   * Release one specific ship from a mission's crew and lower `carrierTarget`
   * to match — an explicit operator removal, unlike releaseFailedCarrier()
   * (an unreachable ship), should not trigger an immediate auto-replacement
   * next tick.
   */
  async removeCarrier(waypointSymbol: string, shipSymbol: string): Promise<void> {
    const mission = this.active.get(waypointSymbol);
    if (!mission) return;
    const idx = mission.assignedShips.indexOf(shipSymbol);
    if (idx === -1) return;
    mission.assignedShips.splice(idx, 1);
    mission.carrierTarget = Math.max(0, mission.carrierTarget - 1);
    this.tasks.get(waypointSymbol)?.delete(shipSymbol);
    this.resume?.(shipSymbol);
    await this.persist(mission);
    this.log(`mission ${waypointSymbol}: ${shipSymbol} removed from crew (${mission.assignedShips.length}/${mission.carrierTarget})`);
    this.onActivity?.("mission", `${shipSymbol} removed from ${waypointSymbol} by operator`, 0, shipSymbol);
  }

  /**
   * Set the crew size this mission wants staffed. The auto-picker in step()
   * ramps up toward it one ship per tick; setting a lower target than the
   * current crew releases the excess immediately (most-recently-added first).
   */
  async setCarrierTarget(waypointSymbol: string, count: number): Promise<void> {
    const mission = this.active.get(waypointSymbol);
    if (!mission) throw new Error(`no active mission at ${waypointSymbol}`);
    const target = Math.max(0, Math.floor(count));
    mission.carrierTarget = target;
    while (mission.assignedShips.length > target) {
      const ship = mission.assignedShips.pop()!;
      this.tasks.get(waypointSymbol)?.delete(ship);
      this.resume?.(ship);
      this.log(`mission ${waypointSymbol}: ${ship} released (crew target lowered to ${target})`);
    }
    await this.persist(mission);
  }

  /** Pause a mission: stop sourcing/spending, release the whole crew to autonomy. */
  async pause(waypointSymbol: string): Promise<void> {
    if (!this.active.has(waypointSymbol)) return;
    this.paused.add(waypointSymbol);
    const mission = this.active.get(waypointSymbol)!;
    for (const ship of mission.assignedShips) {
      this.resume?.(ship);
      this.log(`mission ${waypointSymbol}: paused, released ${ship}`);
    }
    // Actually let go, not just resume — leaving assignedShips set kept
    // those ships permanently reported by committedShips() (nothing ever
    // clears it while the mission sits paused), which meant syncShipClaims()
    // re-claimed them as owner "mission" on every subsequent tick and —
    // since mission outranks warehouse in ShipRegistry's precedence —
    // silently made them un-designatable as the warehouse ship for as long
    // as the mission stayed paused. Confirmed live and by a targeted test.
    // resumeMission() already handles a cleared crew correctly: step()'s
    // auto-pick branch just fills back up toward carrierTarget.
    mission.assignedShips = [];
    this.tasks.delete(waypointSymbol);
    await this.persist(mission);
  }

  /** Resume a paused mission. */
  async resumeMission(waypointSymbol: string): Promise<void> {
    if (!this.paused.delete(waypointSymbol)) return;
    const mission = this.active.get(waypointSymbol);
    if (mission) {
      this.tasks.set(waypointSymbol, new Map());
      await this.persist(mission);
      this.log(`mission ${waypointSymbol}: resumed`);
    }
  }

  /** True if the mission at `waypointSymbol` is paused. */
  isPaused(waypointSymbol: string): boolean {
    return this.paused.has(waypointSymbol);
  }

  /** Advance a single mission one step: reconcile, auto-crew toward
   *  carrierTarget, then step every currently-assigned carrier once. */
  private async step(mission: Mission): Promise<void> {
    const shipTasks = this.tasks.get(mission.targetWaypoint);
    if (!shipTasks) return;

    // Reconcile fulfilled counts against the authoritative construction state.
    const c = await this.api.getConstruction(mission.targetSystem, mission.targetWaypoint);
    for (const m of mission.materials) {
      const live = c.materials.find((x) => x.tradeSymbol === m.tradeSymbol);
      if (live) m.fulfilled = live.fulfilled;
    }
    if (c.isComplete || mission.materials.every((m) => m.fulfilled >= m.required)) {
      mission.status = "complete";
      this.releaseCarrier(mission);
      if (this.tenantId) await this.store?.completeMission(this.tenantId, mission.targetWaypoint);
      this.log(`MISSION COMPLETE: ${mission.targetWaypoint}`);
      this.onActivity?.("mission", `mission complete: ${mission.targetWaypoint}`, 0, undefined);
      return;
    }

    // Auto-crew toward carrierTarget, one ship per tick (same throttled
    // ramp-up the old single-carrier auto-pick used) — only once we know
    // there's real work to do (a market that sells a needed material).
    // Otherwise the mission surveys markets while every ship keeps
    // producing — a blocked mission must never idle a miner.
    //
    // Check every outstanding material, not just whichever sorts first: this
    // gate used to look at only mission.materials.find(...)'s first result
    // (typically FAB_MATS), so if THAT one had no known buyer, no carrier
    // ever got assigned at all — even when a different outstanding material
    // (e.g. ADVANCED_CIRCUITRY) had a perfectly good known seller the whole
    // time. Same fixation bug as stepCarrier()'s own material selection, one
    // level higher: this is the gate that decides whether to assign a
    // carrier in the first place, so getting it wrong here means the
    // carrier-level fix never even gets a chance to run.
    if (mission.assignedShips.length < mission.carrierTarget) {
      const outstanding = mission.materials.filter((m) => m.fulfilled < m.required);
      let sourceable: MissionMaterial | undefined;
      for (const m of outstanding) {
        if (((await this.listBuyers?.(m.tradeSymbol, mission.targetSystem)) ?? []).length > 0) { sourceable = m; break; }
      }
      if (!sourceable) {
        const last = this.preAssignDiscoverRetry.get(mission.targetWaypoint) ?? 0;
        if (Date.now() >= last) {
          this.preAssignDiscoverRetry.set(mission.targetWaypoint, Date.now() + 15_000);
          await this.maybeDiscover(mission, outstanding[0]?.tradeSymbol);
        }
      } else {
        const carrier = await this.pickCarrier?.(this.committedShips(), mission.targetWaypoint);
        if (carrier) {
          mission.assignedShips.push(carrier);
          shipTasks.set(carrier, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
          await this.suspend?.(carrier);
          this.log(`mission ${mission.targetWaypoint}: assigned carrier ${carrier} (${mission.assignedShips.length}/${mission.carrierTarget})`);
          await this.persist(mission);
          this.onActivity?.("mission", `assigned ${carrier} to ${mission.targetWaypoint}`, 0, carrier);
        }
      }
    }

    for (const shipSymbol of [...mission.assignedShips]) {
      const t = shipTasks.get(shipSymbol);
      if (!t) continue;
      // Back off if this carrier hit a rate limit / error recently. Checked
      // per-ship, before any API call for that ship — see the historical
      // note above on why this has to come before getConstruction: the same
      // reasoning applies per-carrier now that there can be several.
      if (t.retryAt > Date.now()) continue;
      try {
        await this.stepCarrier(mission, shipSymbol, t);
      } catch (err) {
        this.log(`mission ${mission.targetWaypoint}: ${shipSymbol} step error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** When sourcing is blocked, survey unknown markets for `tradeSymbol` before
   *  assigning a ship. Takes the material explicitly rather than re-deriving
   *  "whichever is fulfilled < required first" internally — that used to
   *  silently ignore which material the caller actually meant (stepCarrier()
   *  calling this about a specific blocked t.currentMaterial, e.g., would
   *  actually survey for an unrelated, always-first-in-array material
   *  instead). */
  private async maybeDiscover(mission: Mission, tradeSymbol: string | undefined): Promise<void> {
    if (!this.discoverBuyers || !tradeSymbol) return;
    const found = await this.discoverBuyers(tradeSymbol, mission.targetSystem);
    if (found.length > 0) {
      this.log(`mission ${mission.targetWaypoint}: discovered sellers of ${tradeSymbol}: ${found.map((b) => `${b.waypoint}@${b.purchasePrice}c`).join(", ")}`);
    } else {
      this.log(`mission ${mission.targetWaypoint}: no source found for ${tradeSymbol}; still surveying (next in 15s)`);
    }
  }

  /** Temporarily deprioritize a material in favor of other outstanding ones
   *  (see the material-selection comment in stepCarrier()), and clear the
   *  carrier's current pick so the next tick re-selects. Not a permanent
   *  give-up: once blockedUntil passes, this material is eligible again. */
  private blockMaterial(t: TaskState, tradeSymbol: string): void {
    (t.blockedUntil ??= {})[tradeSymbol] = Date.now() + 5 * 60_000;
    t.currentMaterial = undefined;
    t.market = undefined;
    t.basePrice = undefined;
  }

  /** Free the hold of anything that isn't `keep` (the mission's own material)
   *  or FUEL — selling for real credits at the ship's current market where
   *  possible, jettisoning only what genuinely can't be sold there. Confirmed
   *  live: this used to jettison unconditionally, which silently discarded
   *  an 80u FOOD purchase (~104,860c) the moment a mission commandeered a
   *  trader mid-buy (EWOK-14). */
  private async clearUnrelatedCargo(shipSymbol: string, keep: string, inventory: { symbol: string; units: number }[]): Promise<void> {
    for (const item of inventory) {
      if (item.symbol === keep || item.symbol === "FUEL" || item.units <= 0) continue;
      try {
        await this.sellCargo?.(shipSymbol, item.symbol, item.units);
      } catch {
        await this.jettisonCargo?.(shipSymbol, item.symbol, item.units);
      }
    }
  }

  /** Drive one carrier ship through the supply loop. */
  private async stepCarrier(mission: Mission, shipSymbol: string, t: TaskState): Promise<void> {
    const ship = await this.getShip?.(shipSymbol);
    if (!ship) return;
    if (ship.nav.status === "IN_TRANSIT") return; // wait for arrival

    // A carrier that cannot reach the target on a full tank — directly, or via
    // refuel stops along the way — can never complete the mission. Release it
    // (not the mission itself — see releaseFailedCarrier()'s own comment) so
    // a capable ship can be picked instead.
    if (this.canReach && !(await this.canReach(ship.symbol, mission.targetWaypoint))) {
      this.log(`mission ${mission.targetWaypoint}: ${ship.symbol} cannot reach target (no viable route); releasing`);
      await this.releaseFailedCarrier(mission, shipSymbol, t);
      return;
    }
    if (!this.canReach && this.estimatedFuelBetween && ship.fuel.capacity > 0) {
      const need = this.estimatedFuelBetween(ship.nav.waypointSymbol, mission.targetWaypoint);
      if (need > ship.fuel.capacity) {
        this.log(`mission ${mission.targetWaypoint}: ${ship.symbol} cannot reach target (need ${need} fuel, tank ${ship.fuel.capacity}); releasing`);
        await this.releaseFailedCarrier(mission, shipSymbol, t);
        return;
      }
    }

    // 1) Choose the next material that still needs units. A construction
    // site typically needs several materials at once (e.g. FAB_MATS *and*
    // ADVANCED_CIRCUITRY) — with exactly one carrier assigned per mission,
    // fixating on whichever material happens to sort first would mean one
    // hard-to-source material (no known seller, a market that keeps failing
    // the purchase) permanently starves every *other* material of any
    // progress at all, even ones with a perfectly good known seller. Skip
    // anything currently marked blocked (see blockMaterial()) in favor of an
    // outstanding material that isn't — falling back to the blocked one
    // anyway only if that's genuinely all that's left to do.
    if (!t.currentMaterial) {
      const now = Date.now();
      const outstanding = mission.materials.filter((m) => m.fulfilled < m.required);
      t.currentMaterial = (outstanding.find((m) => (t.blockedUntil?.[m.tradeSymbol] ?? 0) <= now) ?? outstanding[0])?.tradeSymbol;
      if (!t.currentMaterial) return;
      t.market = undefined;
    }
    const need = mission.materials.find((m) => m.tradeSymbol === t.currentMaterial);
    if (!need) { t.currentMaterial = undefined; return; }

    // 2) Pick a source market for that material, if not already chosen.
    if (!t.market) {
      let buyers = (await this.listBuyers?.(t.currentMaterial, mission.targetSystem)) ?? [];
      if (buyers.length === 0) {
        // No buyer known — actively re-survey instead of idling on a stale/
        // empty cache forever. Market supply in this game rotates, so a
        // material nothing sells today may start being sold tomorrow — but
        // maybeDiscover() is otherwise only called before a carrier is
        // assigned, so once assigned (manually or by the auto-picker), a
        // carrier that hit this branch would sit here permanently with no
        // path back to finding a source, indistinguishable from "broken".
        t.retryAt = Date.now() + 15_000;
        await this.maybeDiscover(mission, t.currentMaterial);
        buyers = (await this.listBuyers?.(t.currentMaterial, mission.targetSystem)) ?? [];
        if (buyers.length === 0) {
          this.blockMaterial(t, t.currentMaterial);
          return;
        }
      }
      t.market = buyers[0]!.waypoint;
      t.basePrice = buyers[0]!.purchasePrice;
    }

    const material = t.currentMaterial;
    const market = t.market;

    // 3) Step through the loop: fly to market → buy → fly to site → supply.
    // Priority: if the carrier is holding any material the site still needs, deliver
    // it FIRST — never wander off to source while carrying cargo the site is waiting
    // on (e.g. after a resume mid-transit).
    const cargo = await this.api.getShipCargo(ship.symbol);
    const neededHeld = mission.materials
      .filter((m) => m.fulfilled < m.required)
      .map((m) => ({ mat: m, held: cargo.inventory.find((i) => i.symbol === m.tradeSymbol)?.units ?? 0 }))
      .filter((x) => x.held > 0)
      .sort((a, b) => b.held - a.held)[0];
    if (neededHeld) {
      if (ship.nav.waypointSymbol !== mission.targetWaypoint) {
        await this.dispatchShip?.(ship.symbol, mission.targetWaypoint);
        return;
      }
      if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
      const toSupply = Math.min(neededHeld.held, neededHeld.mat.required - neededHeld.mat.fulfilled);
      if (toSupply > 0) {
        await this.api.supplyConstruction(mission.targetSystem, mission.targetWaypoint, ship.symbol, neededHeld.mat.tradeSymbol, toSupply);
        this.log(`mission ${mission.targetWaypoint}: supplied ${toSupply}u ${neededHeld.mat.tradeSymbol}`);
        this.onActivity?.("mission", `${ship.symbol} supplied ${toSupply}u ${neededHeld.mat.tradeSymbol} to ${mission.targetWaypoint}`, 0, ship.symbol);
      }
      t.step = "source";
      t.currentMaterial = undefined;
      // Free cargo so the carrier can haul the next batch.
      const freshCargo = await this.api.getShipCargo(ship.symbol);
      await this.clearUnrelatedCargo(ship.symbol, neededHeld.mat.tradeSymbol, freshCargo.inventory);
      return;
    }
    if (ship.nav.waypointSymbol !== market && t.step !== "supply") {
      await this.dispatchShip?.(ship.symbol, market);
      return;
    }
    if (ship.nav.waypointSymbol === market && t.step === "source") {
      if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
      const freeSpace = ship.cargo.capacity - ship.cargo.units;
      if (freeSpace <= 0) {
        // The hold is full of something that isn't this mission's material —
        // confirmed live: a trader grabbed as carrier mid-purchase (80u FOOD,
        // ~104,860c already paid) arrived here with zero room to buy, and the
        // old code advanced to "supply" regardless, silently discarding it a
        // tick later once the supply step found nothing worth delivering.
        // Clear it now, at a real market, so the very next tick can actually
        // buy — recovering real credits where this market takes the good,
        // not just discarding it.
        await this.clearUnrelatedCargo(ship.symbol, material, ship.cargo.inventory);
        return;
      }
      const toBuy = Math.min(need.required - need.fulfilled, freeSpace);
      if (toBuy > 0) {
        const credits = (await this.getCredits?.()) ?? 0;
        const buyer = (await this.listBuyers?.(material, mission.targetSystem))?.find((b) => b.waypoint === market);
        const price = buyer?.purchasePrice ?? 0;
        // This market's own repeated buying can inflate its own price far
        // past what made it worth choosing in the first place — see
        // MAX_MISSION_BUY_INFLATION's doc comment for the live incident this
        // guards against. Re-shop instead of paying whatever the price has
        // drifted to; blockMaterial() clears t.market too, so the very next
        // tick's source step picks fresh from listBuyers() (which may still
        // return this same market once its price has recovered).
        if (t.basePrice !== undefined && price > t.basePrice * (1 + MAX_MISSION_BUY_INFLATION)) {
          t.retryAt = Date.now() + 15_000;
          this.blockMaterial(t, material);
          this.log(`mission ${mission.targetWaypoint}: ${market} price for ${material} rose to ${price}c (was ${t.basePrice}c) — re-shopping instead of buying`);
          return;
        }
        const affordable = price > 0 ? Math.floor(credits / price) : toBuy;
        // Respect the market's per-transaction trade volume limit (e.g. FAB_MATS
        // caps at 20u/tx) — buying more than that fails the whole purchase.
        const volumeCap = buyer?.tradeVolume && buyer.tradeVolume > 0 ? buyer.tradeVolume : toBuy;
        const units = Math.max(1, Math.min(toBuy, affordable, volumeCap));
        try {
          const res = await this.api.purchaseCargo(ship.symbol, material, units);
          this.recordLedger?.({
            timestamp: new Date().toISOString(),
            shipSymbol: ship.symbol,
            waypointSymbol: market,
            type: "PURCHASE",
            tradeSymbol: material,
            units,
            pricePerUnit: res.transaction.pricePerUnit,
            total: res.transaction.totalPrice,
          });
          this.log(`mission ${mission.targetWaypoint}: ${ship.symbol} bought ${units}u ${material} @ ${price}c at ${market}`);
          this.onActivity?.("buy", `${ship.symbol} ${units}u ${material} @ ${res.transaction.pricePerUnit}c at ${market} (mission)`, -res.transaction.totalPrice, ship.symbol);
        } catch (err) {
          // Market may not actually stock it (stale intel), or some other
          // per-purchase failure. Block this material for a while and let a
          // different outstanding one get a turn, rather than retrying the
          // same failing purchase forever while other materials sit idle.
          t.retryAt = Date.now() + 15_000;
          this.blockMaterial(t, material);
          this.log(`mission ${mission.targetWaypoint}: buy ${material} failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        t.step = "supply";
      }
    }
    if (t.step === "supply") {
      if (ship.nav.waypointSymbol !== mission.targetWaypoint) {
        await this.dispatchShip?.(ship.symbol, mission.targetWaypoint);
        return;
      }
      const cargo = await this.api.getShipCargo(ship.symbol);
      const held = cargo.inventory.find((i) => i.symbol === material)?.units ?? 0;
      const toSupply = Math.min(held, need.required - need.fulfilled);
      if (toSupply > 0) {
        if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
        await this.api.supplyConstruction(mission.targetSystem, mission.targetWaypoint, ship.symbol, material, toSupply);
        this.log(`mission ${mission.targetWaypoint}: supplied ${toSupply}u ${material}`);
        this.onActivity?.("mission", `${ship.symbol} supplied ${toSupply}u ${material} to ${mission.targetWaypoint}`, 0, ship.symbol);
      }
      t.step = "source";
      t.currentMaterial = undefined; // move to next material (or end)
      // Free cargo for the next material so the carrier can keep working.
      await this.clearUnrelatedCargo(ship.symbol, material, cargo.inventory);
    }
  }

  /** Restore the whole crew to autonomous control once the mission ends. */
  private releaseCarrier(mission: Mission): void {
    for (const ship of mission.assignedShips) {
      this.resume?.(ship);
      this.log(`mission ${mission.targetWaypoint}: released ${ship}`);
    }
    this.tasks.delete(mission.targetWaypoint);
    this.active.delete(mission.targetWaypoint);
  }

  /** Release one carrier that failed mid-mission (e.g. it can no longer reach
   *  the target), WITHOUT ending the mission or lowering carrierTarget — a
   *  different, capable ship should still get auto-picked on a later tick.
   *
   *  Confirmed live: this call site used to reuse releaseCarrier() above,
   *  which is built for the mission-*complete* case and deletes the mission
   *  from `active`/`tasks` entirely. Reused here, a single reachability
   *  failure — which a ship at the edge of its fuel range can hit on nothing
   *  more than normal drift — silently killed the mission's progress
   *  forever (nothing re-adds it to `active` short of a process restart),
   *  while list() kept reporting the last-*persisted* assignedShip as if
   *  the mission were still running, since this path never touched the
   *  database either. From the operator's side: a mission shows an assigned
   *  ship indefinitely and never moves it, with nothing to suggest why. */
  private async releaseFailedCarrier(mission: Mission, shipSymbol: string, t: TaskState): Promise<void> {
    this.resume?.(shipSymbol);
    this.log(`mission ${mission.targetWaypoint}: released ${shipSymbol}, mission stays active for a new pick`);
    const idx = mission.assignedShips.indexOf(shipSymbol);
    if (idx !== -1) mission.assignedShips.splice(idx, 1);
    this.tasks.get(mission.targetWaypoint)?.delete(shipSymbol);
    t.currentMaterial = undefined;
    t.market = undefined;
    await this.persist(mission);
  }

  // Always derives `paused` from the live this.paused Set rather than
  // trusting a flag on the call site: reconcile() persists a paused
  // mission's refreshed material counts on its slow cadence without ever
  // passing paused explicitly, and the store layer defaults a missing
  // flag to false — so that path was silently writing the mission back
  // to the DB as unpaused while it stayed correctly paused in memory.
  // The next restart then read that stale unpaused row and resumed the
  // mission on its own. Confirmed live: bfc926dc's X1-XB94-I55 mission
  // (paused 2026-09-14T03:32) came back resumed, un-paused, at 11:49 —
  // the first restart after that pause whose only persist() call in
  // between was reconcile()'s.
  private async persist(m: Mission): Promise<void> {
    if (!this.tenantId) return;
    await this.store?.recordMission(this.tenantId, {
      kind: m.kind,
      targetSystem: m.targetSystem,
      targetWaypoint: m.targetWaypoint,
      status: m.status,
      assignedShips: m.assignedShips,
      carrierTarget: m.carrierTarget,
      materials: m.materials,
      paused: this.paused.has(m.targetWaypoint),
    });
  }
}

interface TaskState {
  step: "source" | "supply";
  currentMaterial?: string;
  market?: string;
  /** The purchase price seen when `market` was chosen for `currentMaterial` —
   *  see MAX_MISSION_BUY_INFLATION's own comment for why this exists. */
  basePrice?: number;
  retryAt: number;
  /** tradeSymbol -> timestamp before which material-selection should skip it
   *  in favor of a different outstanding material. See blockMaterial(). */
  blockedUntil?: Record<string, number>;
}

/**
 * How far a mission buy's live price may drift above `t.basePrice` (the
 * price seen when its market was chosen) before treating that market as
 * exhausted and re-shopping. Ordinary trade-route buys already refuse any
 * price above their dispatcher snapshot (trader.ts's runBuy) because that
 * snapshot is refreshed every recompute cycle (~60s); a mission's market
 * pick has no such refresh — the same carrier can return to the same
 * market for hours, and nothing previously re-checked the price between
 * visits. Confirmed live: EWOK's carrier bought the same 43u FAB_MATS lot
 * from the same market five times over two hours as its own repeated
 * buying pushed the price up each visit (13,237c -> 15,432c -> 21,066c/u),
 * spending roughly 3.7M credits before the fleet ran out of cash entirely.
 * 25% tolerates normal single-lot depletion drift while still catching a
 * market being run dry by repeat visits.
 */
const MAX_MISSION_BUY_INFLATION = 0.25;
