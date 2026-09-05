import type { GalaxyAtlas } from "./galaxy.js";
import type { MarketSnapshot } from "./market.js";
import type { components } from "../core/client.js";

export type WaypointType = components["schemas"]["WaypointType"];

export interface WaypointPos {
  symbol: string;
  x: number;
  y: number;
  type?: WaypointType;
}

/**
 * The fleet's single source of world truth — `docs/control-plane-data-plane.md`
 * §3. Everything here is derived live from the one `GalaxyAtlas` instance the
 * process already holds, plus the market snapshots recorded as ships dock.
 *
 * The point is what this class does NOT do: hand anybody a copy.
 *
 * Today every agent is seeded once, at construction, via `withWorld()` — its
 * own private `waypointPositions` map and `markets` array, frozen at whatever
 * the fleet knew at that moment. Four separate live failures came from that
 * copy going stale, each one patched by adding another push
 * (`reseedAgentWorlds()`, `ensureSystemCharted()`, the `isMarketWaypoint`
 * callback):
 *
 *   - a scout parked on a FUEL_STATION whose prices had never been recorded
 *     reported "stranded, no reachable market" while sitting on a fuel pump
 *     (DAGGER-13 at X1-TP98-A14X, 27/300 fuel);
 *   - ships that came back from a restart in a system nobody had charted
 *     computed every distance as unknown and idled;
 *   - tour scouts rejected their whole target list as unreachable;
 *   - refuel and sell targets were picked in other systems entirely, because
 *     an unknown position silently read as zero distance away.
 *
 * A reference cannot go stale, so none of those pushes are needed once every
 * reader goes through here. `withWorld()`, `reseedAgentWorlds()` and
 * `chartSystemFor()` all get deleted as their callers migrate.
 *
 * `version` exists for observability rather than correctness — nothing has to
 * poll it, since readers hold the live object. It gives the dashboard and the
 * step reports something to quote when explaining what a ship could see at
 * the moment it made a decision.
 */
export class Registry {
  private readonly marketsByWaypoint = new Map<string, MarketSnapshot>();
  private _version = 0;

  constructor(private readonly galaxy: GalaxyAtlas) {}

  get version(): number {
    return this._version;
  }

  /**
   * The system a waypoint belongs to, by symbol convention
   * (`X1-KU72-C44` → `X1-KU72`). Deliberately string-derived rather than
   * looked up: it must work for a waypoint no scan has reached yet, and the
   * callers that matter most are the ones asking precisely because they do
   * not have the waypoint in the atlas.
   */
  systemOf(waypointSymbol: string): string {
    return waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
  }

  /** Live position, or undefined if no scan has reached this waypoint. */
  position(waypointSymbol: string): WaypointPos | undefined {
    const sys = this.galaxy.getSystem(this.systemOf(waypointSymbol));
    const w = sys?.waypoints.find((wp) => wp.symbol === waypointSymbol);
    return w ? { symbol: w.symbol, x: w.x, y: w.y, type: w.type } : undefined;
  }

  /** Every known waypoint in a system. Empty for a system never loaded. */
  waypointsIn(systemSymbol: string): WaypointPos[] {
    const sys = this.galaxy.getSystem(systemSymbol);
    if (!sys) return [];
    return sys.waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type }));
  }

  typeOf(waypointSymbol: string): WaypointType | undefined {
    return this.position(waypointSymbol)?.type;
  }

  /**
   * Straight-line distance between two waypoints, or `Infinity` when it
   * cannot be measured — an unknown position on either end, or the two
   * sitting in different systems.
   *
   * Both of those must fail closed, and this is the one place that rule now
   * lives. Every caller compares the result against a fuel budget and skips
   * what exceeds it, so `Infinity` simply excludes what we cannot measure,
   * where returning 0 made exactly the candidates we knew least about score
   * best. Cross-system is the same class of error for a different reason:
   * waypoint coordinates are per-system, so `hypot()` across a system
   * boundary compares two unrelated coordinate spaces and produces a number
   * that means nothing. A leg like that needs a jump, not a navigate.
   *
   * Note for callers picking a flight mode: `Infinity` here means "unmeasured",
   * NOT "very far". Feeding it to `chooseFlightMode()` reads as
   * `currentFuel < Infinity` and picks DRIFT every time, which is how a
   * trader once spent seven and a half hours on a 172-unit leg with a nearly
   * full tank. Check `Number.isFinite()` before letting this drive a mode.
   */
  distance(from: string, to: string): number {
    if (this.systemOf(from) !== this.systemOf(to)) return Infinity;
    const a = this.position(from);
    const b = this.position(to);
    if (!a || !b) return Infinity;
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Whole-unit fuel estimate for a leg, or `Infinity` when unmeasurable. Same rules as distance(). */
  fuelFor(from: string, to: string): number {
    const d = this.distance(from, to);
    return Number.isFinite(d) ? Math.max(1, Math.round(d)) : Infinity;
  }

  /**
   * Whether a waypoint carries a trait, from the atlas — what the waypoint
   * *is*, never what we happen to hold prices for.
   */
  hasTrait(waypointSymbol: string, trait: string): boolean {
    const sys = this.galaxy.getSystem(this.systemOf(waypointSymbol));
    return sys?.waypoints.some((w) => w.symbol === waypointSymbol && w.traits.some((t) => t.symbol === trait)) ?? false;
  }

  /**
   * Marketplace by trait. This is the authoritative answer, and it is
   * deliberately not "do we have a snapshot for it" — a ship standing on an
   * unsnapshotted fuel station is still standing on a pump.
   */
  isMarket(waypointSymbol: string): boolean {
    return this.hasTrait(waypointSymbol, "MARKETPLACE");
  }

  isShipyard(waypointSymbol: string): boolean {
    return this.hasTrait(waypointSymbol, "SHIPYARD");
  }

  /** The recorded price snapshot for a waypoint, if one has ever been taken. */
  market(waypointSymbol: string): MarketSnapshot | undefined {
    return this.marketsByWaypoint.get(waypointSymbol);
  }

  /** Every snapshotted market, optionally narrowed to one system. */
  markets(systemSymbol?: string): MarketSnapshot[] {
    const all = [...this.marketsByWaypoint.values()];
    return systemSymbol === undefined ? all : all.filter((m) => m.systemSymbol === systemSymbol);
  }

  /**
   * Marketplaces in a system by trait, whether or not prices have ever been
   * recorded for them — the right pool for "where can I refuel", which does
   * not need prices, as opposed to markets(), which is the pool for "who pays
   * best", which does.
   */
  marketWaypointsIn(systemSymbol: string): WaypointPos[] {
    return this.waypointsIn(systemSymbol).filter((w) => this.isMarket(w.symbol));
  }

  /** Record or replace a market snapshot. Called as ships dock, and from a survey. */
  recordMarket(snapshot: MarketSnapshot): void {
    this.marketsByWaypoint.set(snapshot.symbol, snapshot);
    this._version += 1;
  }

  recordMarkets(snapshots: MarketSnapshot[]): void {
    for (const s of snapshots) this.marketsByWaypoint.set(s.symbol, s);
    if (snapshots.length) this._version += 1;
  }

  /** Bump the version after a chart or survey mutated the atlas underneath us. */
  noteTopologyChanged(): void {
    this._version += 1;
  }
}
