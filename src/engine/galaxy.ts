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
