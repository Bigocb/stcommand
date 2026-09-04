import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";

export type Waypoint = components["schemas"]["Waypoint"];
export type JumpGate = components["schemas"]["JumpGate"];
export type System = components["schemas"]["System"];
export type ShipyardShip = components["schemas"]["ShipyardShip"];

export interface KnownSystem {
  symbol: string;
  waypoints: Waypoint[];
  jumpGates: JumpGate[];
  markets: MarketSnapshot[];
  shipyards: { symbol: string; ships: ShipyardShip[]; modificationsFee: number }[];
}
/** Persisted topology cache GalaxyAtlas checks before a live scan — see
 *  Store.getSystemTopology()/setSystemTopology()'s own comment. Structural,
 *  not the real Store type, so this module doesn't have to import db/store.ts. */
export interface GalaxyStore {
  getSystemTopology(systemSymbol: string): Promise<{ waypoints: unknown[]; jumpGates: unknown[] } | undefined>;
  setSystemTopology(systemSymbol: string, waypoints: unknown[], jumpGates: unknown[]): Promise<void>;
}

/** Multi-system atlas: caches waypoints, jump gates, and foreign markets. */
export class GalaxyAtlas {
  private readonly api: SpaceTradersAPI;
  private readonly store?: GalaxyStore;
  private readonly systems = new Map<string, KnownSystem>();
  private readonly jumps = new Map<string, string>(); // gate symbol -> system symbol

  constructor(api: SpaceTradersAPI, store?: GalaxyStore) {
    this.api = api;
    this.store = store;
  }

  /**
   * A system's waypoints (and, once scanJumpGates() has run for it, its jump
   * gates) are effectively static for the life of a server reset — confirmed
   * as one of the main contributors to slow multi-tenant startup and boot-
   * time rate-limit pressure, since every tenant's every boot used to
   * re-fetch this live (getSystem() + a paginated getAllSystemWaypoints())
   * for the same systems over and over. A DB cache hit here is a Postgres
   * read instead of a SpaceTraders round-trip; a miss still falls back to
   * the live scan and seeds the cache for every future boot, tenant, and
   * process restart.
   */
  async loadSystem(systemSymbol: string): Promise<KnownSystem> {
    if (this.systems.has(systemSymbol)) return this.systems.get(systemSymbol)!;
    const cached = await this.store?.getSystemTopology(systemSymbol);
    if (cached) {
      const known: KnownSystem = {
        symbol: systemSymbol,
        waypoints: cached.waypoints as Waypoint[],
        jumpGates: cached.jumpGates as JumpGate[],
        markets: [],
        shipyards: [],
      };
      this.systems.set(systemSymbol, known);
      for (const w of known.waypoints) {
        if (w.type === "JUMP_GATE") this.jumps.set(w.symbol, systemSymbol);
      }
      return known;
    }
    const waypoints = await this.api.getAllSystemWaypoints(systemSymbol);
    const known: KnownSystem = { symbol: systemSymbol, waypoints, jumpGates: [], markets: [], shipyards: [] };
    this.systems.set(systemSymbol, known);
    for (const w of waypoints) {
      if (w.type === "JUMP_GATE") this.jumps.set(w.symbol, systemSymbol);
    }
    // jumpGates is [] here deliberately — scanJumpGates() upserts it again
    // once gates are actually resolved, so a system nobody has scanned gates
    // for yet doesn't get miscached as "confirmed zero gates."
    await this.store?.setSystemTopology(systemSymbol, waypoints, []);
    return known;
  }

  getSystem(symbol: string): KnownSystem | undefined {
    return this.systems.get(symbol);
  }

  listSystems(): KnownSystem[] {
    return [...this.systems.values()];
  }

  /**
   * Discover jump gates and their connected gates in a known system —
   * cache-aware, same as loadSystem(). Skips a gate whose symbol is already
   * present in known.jumpGates (from a prior scan this process, or loaded
   * from the DB cache) instead of a blanket "any cached gates at all means
   * fully scanned" check: a system genuinely has zero gates gets an empty
   * gateWaypoints list up front (no live calls, cache or not) rather than
   * being miscached as "scanned" purely because loadSystem() always seeds
   * jump_gates=[] on a system's very first load.
   */
  async scanJumpGates(systemSymbol: string): Promise<JumpGate[]> {
    const known = await this.loadSystem(systemSymbol);
    const gateWaypoints = known.waypoints.filter((w) => w.type === "JUMP_GATE");
    if (gateWaypoints.length === 0) return known.jumpGates;
    const alreadyResolved = new Set(known.jumpGates.map((jg) => jg.symbol));
    const missing = gateWaypoints.filter((w) => !alreadyResolved.has(w.symbol));
    if (missing.length === 0) return known.jumpGates;
    const results: JumpGate[] = [...known.jumpGates];
    // Concurrent rather than one-gate-at-a-time: the shared rate limiter
    // (client.ts's RateLimiter, FIFO-queued) still throttles the real
    // dispatch rate — this just stops artificially serializing on each
    // gate's full network round-trip before the next one can even start.
    await Promise.allSettled(
      missing.map(async (gate) => {
        try {
          const jg = await this.api.getJumpGate(systemSymbol, gate.symbol);
          results.push(jg);
          await Promise.allSettled(
            jg.connections.map((connected) => this.loadSystem(connected.slice(0, connected.lastIndexOf("-")))),
          );
        } catch (err) {
          // waypoint may not be a jump gate or unreachable
        }
      }),
    );
    known.jumpGates = results;
    await this.store?.setSystemTopology(systemSymbol, known.waypoints, results);
    return results;
  }

  /** Return systems reachable from `systemSymbol` via known jump gates. */
  connectedSystems(systemSymbol: string): string[] {
    const known = this.systems.get(systemSymbol);
    if (!known) return [];
    const connected = new Set<string>();
    for (const jg of known.jumpGates) {
      for (const c of jg.connections) {
        const sys = c.slice(0, c.lastIndexOf("-"));
        if (sys !== systemSymbol) connected.add(sys);
      }
    }
    return [...connected];
  }

  /** Return all jump gate connections as pairs of waypoint symbols. */
  jumpConnections(): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const sys of this.systems.values()) {
      for (const jg of sys.jumpGates) {
        for (const c of jg.connections) out.push({ from: jg.symbol, to: c });
      }
    }
    return out;
  }

  /** Find jump gates in `fromSystem` that connect to `toSystem`. */
  gatesTo(fromSystem: string, toSystem: string): string[] {
    const known = this.systems.get(fromSystem);
    if (!known) return [];
    const out: string[] = [];
    for (const jg of known.jumpGates) {
      if (jg.connections.some((c) => c.startsWith(toSystem + "-"))) out.push(jg.symbol);
    }
    return out;
  }

  /**
   * Cached construction-complete status per gate waypoint. `JumpGate`
   * objects (from scanJumpGates()) carry no construction status at all —
   * that lives on the waypoint (Construction.isComplete), fetched
   * separately — so gate *connectivity* being known says nothing about
   * whether a jump through it will actually succeed.
   *
   * A gate that finishes construction never goes back to incomplete, so
   * once cached `true` a symbol is never re-fetched. Everything else
   * (never checked, or last known incomplete) is refreshed by
   * refreshGateConstruction(), called on a slow interval by
   * FleetManager.tick() rather than from any hot route-scoring path — this
   * cache is what lets canJump()/gateComplete() stay synchronous.
   */
  private readonly gateConstruction = new Map<string, boolean>();

  /** Cached construction-complete status for one gate, or undefined if
   *  never checked (refreshGateConstruction() hasn't resolved for it yet). */
  gateComplete(gateSymbol: string): boolean | undefined {
    return this.gateConstruction.get(gateSymbol);
  }

  /** True if a jump from fromSystem to toSystem is possible right now,
   *  per cached construction status. An unchecked or under-construction
   *  gate reads as not jumpable — the safe default, matching how a fresh
   *  (never-observed) system already behaves everywhere else in this
   *  class. Call refreshGateConstruction() to populate the cache for a
   *  newly-discovered gate; this method itself never makes a network call. */
  canJump(fromSystem: string, toSystem: string): boolean {
    return this.gatesTo(fromSystem, toSystem).some((g) => this.gateConstruction.get(g) === true);
  }

  /**
   * Refresh one gate's cached construction status from the live API.
   * Same isComplete check fleet.ts's exploreSystem()/scoutCanReachUncharted()
   * and trader.ts's canReachMarket() all used to fetch independently — this
   * is now the one place that does, so a gate finishing construction is
   * discovered once and every caller (route scoring, scouting, price
   * discovery) sees it via the cache instead of each polling the API on
   * its own schedule.
   */
  async refreshGateConstruction(systemSymbol: string, gateSymbol: string): Promise<boolean> {
    if (this.gateConstruction.get(gateSymbol) === true) return true; // one-way: never reverts to incomplete
    try {
      const complete = (await this.api.getConstruction(systemSymbol, gateSymbol)).isComplete;
      this.gateConstruction.set(gateSymbol, complete);
      return complete;
    } catch {
      // No construction record: the gate is already built (pre-existing
      // gates were never under construction in the first place).
      this.gateConstruction.set(gateSymbol, true);
      return true;
    }
  }

  /**
   * Refresh construction status for every known gate not yet confirmed
   * complete. Intended to be called on a slow interval (FleetManager.tick()
   * gates this itself), not per route-scoring pass — see
   * refreshGateConstruction()'s own comment.
   */
  async refreshAllGateConstruction(): Promise<void> {
    const pending: { systemSymbol: string; gateSymbol: string }[] = [];
    for (const known of this.systems.values()) {
      for (const jg of known.jumpGates) {
        if (this.gateConstruction.get(jg.symbol) !== true) pending.push({ systemSymbol: known.symbol, gateSymbol: jg.symbol });
      }
    }
    await Promise.allSettled(pending.map((p) => this.refreshGateConstruction(p.systemSymbol, p.gateSymbol)));
  }

  /**
   * Running average of real jumpShip() transaction totals, keyed by
   * (departure gate, destination system) — the two things that determine
   * cost, not the specific in-system waypoint jumped to (antimatter price
   * is set by the connection, not the exact destination within the target
   * system). This is what replaces the flat CROSS_SYSTEM_JUMP_COST_ESTIMATE
   * placeholder once real jumps start happening: no jump cost estimate
   * exists ahead of time (jumpShip() only reveals it in the response), so
   * the only way to know is to have actually paid it before.
   */
  private readonly jumpCosts = new Map<string, { total: number; count: number }>();

  private jumpCostKey(fromGate: string, toSystem: string): string {
    return `${fromGate}->${toSystem}`;
  }

  /** Record what a real jump actually cost, for future estimates over the
   *  same gate/destination-system pair. Called right after a live
   *  jumpShip() call — never invented or estimated. */
  recordJumpCost(fromGate: string, toSystem: string, totalPrice: number): void {
    const key = this.jumpCostKey(fromGate, toSystem);
    const existing = this.jumpCosts.get(key) ?? { total: 0, count: 0 };
    this.jumpCosts.set(key, { total: existing.total + totalPrice, count: existing.count + 1 });
  }

  /** Average of every real jump paid over this gate/destination-system
   *  pair, or undefined if none has ever been recorded — callers fall back
   *  to a flat estimate in that case (see CROSS_SYSTEM_JUMP_COST_ESTIMATE's
   *  own comment). */
  learnedJumpCost(fromGate: string, toSystem: string): number | undefined {
    const entry = this.jumpCosts.get(this.jumpCostKey(fromGate, toSystem));
    return entry ? entry.total / entry.count : undefined;
  }

  /** Fetch markets in a system and cache them as snapshots. */
  async surveyMarkets(systemSymbol: string, store?: {
    recordModuleCatalog: (systemSymbol: string, waypointSymbol: string, items: { symbol: string; name: string; category: string; purchasePrice: number }[], kind: "module" | "mount") => Promise<void>;
  }): Promise<MarketSnapshot[]> {
    const known = await this.loadSystem(systemSymbol);
    const markets: MarketSnapshot[] = [];
    for (const w of known.waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"))) {
      try {
        const market = await this.api.getMarket(systemSymbol, w.symbol);
        const snapshot: MarketSnapshot = {
          symbol: w.symbol,
          systemSymbol,
          tradeGoods: {},
          imports: (market.imports ?? []).map((g) => g.symbol),
          exports: (market.exports ?? []).map((g) => g.symbol),
          exchange: (market.exchange ?? []).map((g) => g.symbol),
          fetchedAt: new Date().toISOString(),
        };
        const moduleGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
        const mountGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
        for (const g of market.tradeGoods ?? []) {
          snapshot.tradeGoods[g.symbol] = g;
          if (g.symbol.startsWith("MODULE_")) {
            moduleGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
          } else if (g.symbol.startsWith("MOUNT_")) {
            mountGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
          }
        }
        markets.push(snapshot);
        if (store) {
          if (moduleGoods.length) await store.recordModuleCatalog(systemSymbol, w.symbol, moduleGoods, "module");
          if (mountGoods.length) await store.recordModuleCatalog(systemSymbol, w.symbol, mountGoods, "mount");
        }
      } catch (err) {
        // market may be un-scanned
      }
    }
    known.markets = markets;
    return markets;
  }

  /** Fetch shipyards in a system and cache inventory. */
  async surveyShipyards(systemSymbol: string, store?: {
    recordShipyardInventory: (systemSymbol: string, waypointSymbol: string, ships: ShipyardShip[]) => Promise<void>;
  }): Promise<{ symbol: string; ships: ShipyardShip[]; modificationsFee: number }[]> {
    const known = await this.loadSystem(systemSymbol);
    const shipyards: { symbol: string; ships: ShipyardShip[]; modificationsFee: number }[] = [];
    for (const w of known.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"))) {
      try {
        const yard = await this.api.getShipyard(systemSymbol, w.symbol);
        const entry = { symbol: w.symbol, ships: yard.ships ?? [], modificationsFee: yard.modificationsFee ?? 0 };
        shipyards.push(entry);
        if (store) await store.recordShipyardInventory(systemSymbol, w.symbol, entry.ships);
      } catch (err) {
        // shipyard may be un-scanned
      }
    }
    known.shipyards = shipyards;
    return shipyards;
  }

  /** Return all cached waypoint positions across known systems. */
  allPositions(): { symbol: string; x: number; y: number; type?: components["schemas"]["WaypointType"]; systemSymbol: string }[] {
    const out: { symbol: string; x: number; y: number; type?: components["schemas"]["WaypointType"]; systemSymbol: string }[] = [];
    for (const sys of this.systems.values()) {
      for (const w of sys.waypoints) {
        out.push({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, systemSymbol: sys.symbol });
      }
    }
    return out;
  }

  /** Record systems revealed by a sensor-array scan (positions only — waypoints come from a waypoint scan or loadSystem). */
  ingestScannedSystems(systems: { symbol: string; x: number; y: number; distance: number }[]): number {
    let added = 0;
    for (const s of systems) {
      if (this.systems.has(s.symbol)) continue;
      this.systems.set(s.symbol, { symbol: s.symbol, waypoints: [], jumpGates: [], markets: [], shipyards: [] });
      added += 1;
    }
    return added;
  }

  /** Record waypoints revealed by a sensor-array scan: positions + traits, even if the system was never loaded in full. */
  ingestScannedWaypoints(waypoints: { symbol: string; systemSymbol: string; x: number; y: number; type?: string; traits?: { symbol: string }[] }[]): number {
    let added = 0;
    for (const w of waypoints) {
      let sys = this.systems.get(w.systemSymbol);
      if (!sys) {
        sys = { symbol: w.systemSymbol, waypoints: [], jumpGates: [], markets: [], shipyards: [] };
        this.systems.set(w.systemSymbol, sys);
      }
      const existing = sys.waypoints.find((ew) => ew.symbol === w.symbol);
      if (existing) {
        if (w.traits?.length && (!existing.traits?.length)) existing.traits = w.traits as Waypoint["traits"];
        continue;
      }
      sys.waypoints.push({
        symbol: w.symbol,
        type: (w.type ?? "PLANET") as Waypoint["type"],
        systemSymbol: w.systemSymbol,
        x: w.x,
        y: w.y,
        orbitals: [],
        traits: (w.traits ?? []).map((t) => ({ symbol: t.symbol, name: t.symbol, description: "" })) as Waypoint["traits"],
        isUnderConstruction: false,
      });
      added += 1;
    }
    return added;
  }
}
