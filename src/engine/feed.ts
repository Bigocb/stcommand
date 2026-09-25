import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { Store } from "../db/store.js";

export type Ship = components["schemas"]["Ship"];

/**
 * A feeder tier: a crew of ships continuously buying `good` wherever it's
 * cheapest and selling it into `targetWaypoint`, to keep that market's price
 * from spiking under a buyer's own repeated purchasing pressure (the
 * "protocol" work — see CLAUDE.md/docs/TODO.md's multi-carrier mission
 * entry, which this is the sibling of).
 *
 * Deliberately separate from MissionManager (src/engine/mission.ts), not a
 * mission kind — kept apart per operator request, and structurally a feed
 * has no construction site and no required/fulfilled materials to reconcile
 * against; it never "completes" the way a mission does, it just runs until
 * the operator pauses or removes it. The crew shape (assignedShips/
 * carrierTarget, one independent TaskState per ship) mirrors MissionManager
 * on purpose — same operator-facing pattern, same throttled auto-ramp — but
 * nothing here reads from or writes to `missions`/`feed`'s own committed
 * ships must still be excluded from each other's carrier picks (done by the
 * caller, via committedShips() on both).
 */
export interface Feed {
  targetSystem: string;
  targetWaypoint: string;
  good: string;
  assignedShips: string[];
  carrierTarget: number;
  paused?: boolean;
}

interface FeedTaskState {
  market?: string;
  /** Purchase price seen when `market` was chosen — see MAX_FEED_BUY_INFLATION. */
  basePrice?: number;
  retryAt: number;
}

interface FeedOptions {
  api: SpaceTradersAPI;
  store?: Store;
  tenantId?: string;
  log?: (msg: string) => void;
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  getShip?: (symbol: string) => Promise<Ship>;
  estimatedFuelBetween?: (a: string, b: string) => number;
  canReach?: (shipSymbol: string, targetWaypoint: string) => Promise<boolean>;
  dispatchShip?: (shipSymbol: string, waypointSymbol: string) => Promise<void>;
  pickCarrier?: (exclude: Set<string>, targetWaypoint?: string) => Promise<string | undefined>;
  suspend?: (shipSymbol: string) => void | Promise<void>;
  resume?: (shipSymbol: string) => void;
  /** Sources known to sell a trade good in the given system, cheapest first. */
  listBuyers?: (tradeSymbol: string, systemSymbol: string) => Promise<{ waypoint: string; purchasePrice: number; tradeVolume: number }[]>;
  discoverBuyers?: (tradeSymbol: string, systemSymbol: string) => Promise<{ waypoint: string; purchasePrice: number }[]>;
  getCredits?: () => Promise<number>;
  sellCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
  jettisonCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
}

/** How far a feed buy's live price may drift above the price seen when its
 *  source market was chosen before re-shopping — same guard and same
 *  reasoning as MissionManager's MAX_MISSION_BUY_INFLATION (a market a crew
 *  keeps returning to inflates against its own repeated buying). */
const MAX_FEED_BUY_INFLATION = 0.25;

/** How often a *paused* feed's crew-size display gets rechecked — feeds
 *  don't reconcile against a live construction API the way missions do,
 *  so there's nothing to poll while paused; kept only so a resumed feed's
 *  first tick after a long pause isn't treated as overdue. */
const PAUSED_TOUCH_MS = 60_000;

export class FeedManager {
  private readonly api: SpaceTradersAPI;
  private readonly store?: Store;
  private readonly tenantId?: string;
  private readonly log: (msg: string) => void;
  private readonly onActivity: FeedOptions["onActivity"];
  private readonly getShip?: FeedOptions["getShip"];
  private readonly estimatedFuelBetween?: FeedOptions["estimatedFuelBetween"];
  private readonly canReach?: FeedOptions["canReach"];
  private readonly dispatchShip?: FeedOptions["dispatchShip"];
  private readonly pickCarrier?: FeedOptions["pickCarrier"];
  private readonly suspend?: FeedOptions["suspend"];
  private readonly resume?: FeedOptions["resume"];
  private readonly listBuyers?: FeedOptions["listBuyers"];
  private readonly discoverBuyers?: FeedOptions["discoverBuyers"];
  private readonly getCredits?: FeedOptions["getCredits"];
  private readonly sellCargo?: FeedOptions["sellCargo"];
  private readonly jettisonCargo?: FeedOptions["jettisonCargo"];

  private active = new Map<string, Feed>();
  /** Key → shipSymbol → that ship's own independent TaskState. */
  private tasks = new Map<string, Map<string, FeedTaskState>>();
  private paused = new Set<string>();
  private lastTouch = new Map<string, number>();
  private preAssignDiscoverRetry = new Map<string, number>();

  constructor(opts: FeedOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.tenantId = opts.tenantId;
    this.log = opts.log ?? ((m) => console.log(`[feed] ${m}`));
    this.onActivity = opts.onActivity;
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

  private key(targetWaypoint: string, good: string): string {
    return `${targetWaypoint}::${good}`;
  }

  /** Start (or resume, if already persisted) a feeder tier. */
  async start(targetWaypoint: string, good: string, carrierTarget = 1): Promise<void> {
    const key = this.key(targetWaypoint, good);
    if (this.active.has(key)) return;
    const system = targetWaypoint.slice(0, targetWaypoint.lastIndexOf("-"));
    const known = this.tenantId ? await this.store?.latestFeeds(this.tenantId) : undefined;
    const persisted = known?.find((f) => f.targetWaypoint === targetWaypoint && f.good === good);
    if (persisted) {
      const feed: Feed = {
        targetSystem: system,
        targetWaypoint,
        good,
        assignedShips: [...persisted.assignedShips],
        carrierTarget: persisted.carrierTarget,
      };
      this.active.set(key, feed);
      if (persisted.paused) {
        this.paused.add(key);
        this.log(`feed resumed (from prior state, PAUSED): ${good} → ${targetWaypoint}`);
        return;
      }
      const shipTasks = new Map<string, FeedTaskState>();
      for (const s of feed.assignedShips) {
        shipTasks.set(s, { retryAt: 0 });
        await this.suspend?.(s);
      }
      this.tasks.set(key, shipTasks);
      this.log(`feed resumed (from prior state): ${good} → ${targetWaypoint}`);
      return;
    }
    const feed: Feed = { targetSystem: system, targetWaypoint, good, assignedShips: [], carrierTarget };
    this.active.set(key, feed);
    this.tasks.set(key, new Map());
    await this.persist(feed);
    this.log(`feed started: ${good} → ${targetWaypoint} (crew target ${carrierTarget})`);
    this.onActivity?.("feed", `feeder started: ${good} → ${targetWaypoint}`, 0, undefined);
  }

  /** Full list of known feeds. */
  async list(): Promise<Feed[]> {
    const rows = this.tenantId ? await this.store?.latestFeeds(this.tenantId) : undefined;
    const persisted: Feed[] = (rows ?? []).map((f) => ({
      targetSystem: f.targetSystem,
      targetWaypoint: f.targetWaypoint,
      good: f.good,
      assignedShips: f.assignedShips,
      carrierTarget: f.carrierTarget,
      paused: f.paused,
    }));
    return [...this.active.values(), ...persisted.filter((p) => !this.active.has(this.key(p.targetWaypoint, p.good)))]
      .map((f) => ({ ...f, paused: this.active.has(this.key(f.targetWaypoint, f.good)) ? this.paused.has(this.key(f.targetWaypoint, f.good)) : (f.paused ?? false) }));
  }

  /** Ships currently committed to any feed — must not be reassigned elsewhere. */
  committedShips(): Set<string> {
    const out = new Set<string>();
    for (const f of this.active.values()) for (const s of f.assignedShips) out.add(s);
    return out;
  }

  async assignCarrier(targetWaypoint: string, good: string, shipSymbol: string): Promise<void> {
    const key = this.key(targetWaypoint, good);
    const feed = this.active.get(key);
    if (!feed) throw new Error(`no active feed for ${good} → ${targetWaypoint}`);
    if (feed.assignedShips.includes(shipSymbol)) return;
    feed.assignedShips.push(shipSymbol);
    if (feed.carrierTarget < feed.assignedShips.length) feed.carrierTarget = feed.assignedShips.length;
    await this.suspend?.(shipSymbol);
    if (!this.paused.has(key)) {
      const shipTasks = this.tasks.get(key) ?? new Map<string, FeedTaskState>();
      shipTasks.set(shipSymbol, { retryAt: 0 });
      this.tasks.set(key, shipTasks);
    }
    await this.persist(feed);
    this.log(`feed ${good} → ${targetWaypoint}: ${shipSymbol} added to crew (${feed.assignedShips.length}/${feed.carrierTarget})`);
    this.onActivity?.("feed", `${shipSymbol} assigned to feed ${good} → ${targetWaypoint} by operator`, 0, shipSymbol);
  }

  async removeCarrier(targetWaypoint: string, good: string, shipSymbol: string): Promise<void> {
    const key = this.key(targetWaypoint, good);
    const feed = this.active.get(key);
    if (!feed) return;
    const idx = feed.assignedShips.indexOf(shipSymbol);
    if (idx === -1) return;
    feed.assignedShips.splice(idx, 1);
    feed.carrierTarget = Math.max(0, feed.carrierTarget - 1);
    this.tasks.get(key)?.delete(shipSymbol);
    this.resume?.(shipSymbol);
    await this.persist(feed);
    this.log(`feed ${good} → ${targetWaypoint}: ${shipSymbol} removed from crew (${feed.assignedShips.length}/${feed.carrierTarget})`);
    this.onActivity?.("feed", `${shipSymbol} removed from feed ${good} → ${targetWaypoint} by operator`, 0, shipSymbol);
  }

  async setCarrierTarget(targetWaypoint: string, good: string, count: number): Promise<void> {
    const key = this.key(targetWaypoint, good);
    const feed = this.active.get(key);
    if (!feed) throw new Error(`no active feed for ${good} → ${targetWaypoint}`);
    const target = Math.max(0, Math.floor(count));
    feed.carrierTarget = target;
    while (feed.assignedShips.length > target) {
      const ship = feed.assignedShips.pop()!;
      this.tasks.get(key)?.delete(ship);
      this.resume?.(ship);
      this.log(`feed ${good} → ${targetWaypoint}: ${ship} released (crew target lowered to ${target})`);
    }
    await this.persist(feed);
  }

  /** Pause a feed: release its whole crew to autonomy, stop buying/selling. */
  async pause(targetWaypoint: string, good: string): Promise<void> {
    const key = this.key(targetWaypoint, good);
    if (!this.active.has(key)) return;
    this.paused.add(key);
    const feed = this.active.get(key)!;
    for (const ship of feed.assignedShips) {
      this.resume?.(ship);
      this.log(`feed ${good} → ${targetWaypoint}: paused, released ${ship}`);
    }
    feed.assignedShips = [];
    this.tasks.delete(key);
    await this.persist(feed);
  }

  async resumeFeed(targetWaypoint: string, good: string): Promise<void> {
    const key = this.key(targetWaypoint, good);
    if (!this.paused.delete(key)) return;
    const feed = this.active.get(key);
    if (feed) {
      this.tasks.set(key, new Map());
      await this.persist(feed);
      this.log(`feed ${good} → ${targetWaypoint}: resumed`);
    }
  }

  /** Stop and forget a feed entirely (not just paused) — releases the crew
   *  and removes the persisted row, unlike pause() which keeps it around
   *  to resume later. */
  async remove(targetWaypoint: string, good: string): Promise<void> {
    const key = this.key(targetWaypoint, good);
    const feed = this.active.get(key);
    if (feed) {
      for (const ship of feed.assignedShips) this.resume?.(ship);
    }
    this.active.delete(key);
    this.tasks.delete(key);
    this.paused.delete(key);
    if (this.tenantId) await this.store?.deleteFeed(this.tenantId, targetWaypoint, good);
    this.log(`feed ${good} → ${targetWaypoint}: removed`);
  }

  isPaused(targetWaypoint: string, good: string): boolean {
    return this.paused.has(this.key(targetWaypoint, good));
  }

  /** Advance every active feed by one step. Call once per coordinator tick. */
  async tick(): Promise<void> {
    for (const feed of [...this.active.values()]) {
      const key = this.key(feed.targetWaypoint, feed.good);
      if (this.paused.has(key)) {
        const last = this.lastTouch.get(key) ?? 0;
        if (Date.now() - last >= PAUSED_TOUCH_MS) this.lastTouch.set(key, Date.now());
        continue;
      }
      try {
        await this.step(feed);
      } catch (err) {
        this.log(`feed ${feed.good} → ${feed.targetWaypoint} step error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Advance one feed: auto-crew toward carrierTarget, then step every
   *  currently-assigned carrier once. */
  private async step(feed: Feed): Promise<void> {
    const key = this.key(feed.targetWaypoint, feed.good);
    const shipTasks = this.tasks.get(key);
    if (!shipTasks) return;

    if (feed.assignedShips.length < feed.carrierTarget) {
      const buyers = (await this.listBuyers?.(feed.good, feed.targetSystem)) ?? [];
      if (buyers.length === 0) {
        const last = this.preAssignDiscoverRetry.get(key) ?? 0;
        if (Date.now() >= last) {
          this.preAssignDiscoverRetry.set(key, Date.now() + 15_000);
          if (this.discoverBuyers) {
            const found = await this.discoverBuyers(feed.good, feed.targetSystem);
            this.log(found.length > 0
              ? `feed ${feed.good} → ${feed.targetWaypoint}: discovered sellers: ${found.map((b) => `${b.waypoint}@${b.purchasePrice}c`).join(", ")}`
              : `feed ${feed.good} → ${feed.targetWaypoint}: no source found; still surveying (next in 15s)`);
          }
        }
      } else {
        const carrier = await this.pickCarrier?.(this.committedShips(), feed.targetWaypoint);
        if (carrier) {
          feed.assignedShips.push(carrier);
          shipTasks.set(carrier, { retryAt: 0 });
          await this.suspend?.(carrier);
          this.log(`feed ${feed.good} → ${feed.targetWaypoint}: assigned carrier ${carrier} (${feed.assignedShips.length}/${feed.carrierTarget})`);
          await this.persist(feed);
          this.onActivity?.("feed", `assigned ${carrier} to feed ${feed.good} → ${feed.targetWaypoint}`, 0, carrier);
        }
      }
    }

    for (const shipSymbol of [...feed.assignedShips]) {
      const t = shipTasks.get(shipSymbol);
      if (!t) continue;
      if (t.retryAt > Date.now()) continue;
      try {
        await this.stepCarrier(feed, shipSymbol, t);
      } catch (err) {
        this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${shipSymbol} step error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Free the hold of anything that isn't `keep` or FUEL — sells for real
   *  credits where possible, jettisons only what genuinely can't be sold. */
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

  /** Drive one carrier through the buy-cheap → sell-into-target loop. */
  private async stepCarrier(feed: Feed, shipSymbol: string, t: FeedTaskState): Promise<void> {
    const ship = await this.getShip?.(shipSymbol);
    if (!ship) return;
    if (ship.nav.status === "IN_TRANSIT") return;

    if (this.canReach && !(await this.canReach(ship.symbol, feed.targetWaypoint))) {
      this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${ship.symbol} cannot reach target (no viable route); releasing`);
      await this.releaseFailedCarrier(feed, shipSymbol, t);
      return;
    }
    if (!this.canReach && this.estimatedFuelBetween && ship.fuel.capacity > 0) {
      const need = this.estimatedFuelBetween(ship.nav.waypointSymbol, feed.targetWaypoint);
      if (need > ship.fuel.capacity) {
        this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${ship.symbol} cannot reach target (need ${need} fuel, tank ${ship.fuel.capacity}); releasing`);
        await this.releaseFailedCarrier(feed, shipSymbol, t);
        return;
      }
    }

    const cargo = await this.api.getShipCargo(ship.symbol);
    const held = cargo.inventory.find((i) => i.symbol === feed.good)?.units ?? 0;

    // Holding the good already: deliver it before sourcing more.
    if (held > 0) {
      if (ship.nav.waypointSymbol !== feed.targetWaypoint) {
        await this.dispatchShip?.(ship.symbol, feed.targetWaypoint);
        return;
      }
      if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
      try {
        const res = await this.api.sellCargo(ship.symbol, feed.good, held);
        this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${ship.symbol} sold ${held}u @ ${res.transaction.pricePerUnit}c = ${res.transaction.totalPrice}c`);
        this.onActivity?.("feed", `${ship.symbol} fed ${held}u ${feed.good} into ${feed.targetWaypoint}`, res.transaction.totalPrice, ship.symbol);
      } catch (err) {
        this.log(`feed ${feed.good} → ${feed.targetWaypoint}: sell failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      t.market = undefined;
      const freshCargo = await this.api.getShipCargo(ship.symbol);
      await this.clearUnrelatedCargo(ship.symbol, feed.good, freshCargo.inventory);
      return;
    }

    // Empty-handed: pick a cheap source market if we don't already have one.
    if (!t.market) {
      const buyers = (await this.listBuyers?.(feed.good, feed.targetSystem)) ?? [];
      if (buyers.length === 0) {
        t.retryAt = Date.now() + 15_000;
        return;
      }
      t.market = buyers[0]!.waypoint;
      t.basePrice = buyers[0]!.purchasePrice;
    }
    if (ship.nav.waypointSymbol !== t.market) {
      await this.dispatchShip?.(ship.symbol, t.market);
      return;
    }
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
    const freeSpace = ship.cargo.capacity - ship.cargo.units;
    if (freeSpace <= 0) {
      await this.clearUnrelatedCargo(ship.symbol, feed.good, ship.cargo.inventory);
      return;
    }
    const sourceMarket = t.market;
    const basePrice = t.basePrice;
    const credits = (await this.getCredits?.()) ?? 0;
    const buyer = (await this.listBuyers?.(feed.good, feed.targetSystem))?.find((b) => b.waypoint === sourceMarket);
    const price = buyer?.purchasePrice ?? 0;
    if (basePrice !== undefined && price > basePrice * (1 + MAX_FEED_BUY_INFLATION)) {
      t.retryAt = Date.now() + 15_000;
      t.market = undefined;
      t.basePrice = undefined;
      this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${sourceMarket} price for ${feed.good} rose to ${price}c (was ${basePrice}c) — re-shopping instead of buying`);
      return;
    }
    const affordable = price > 0 ? Math.floor(credits / price) : freeSpace;
    const volumeCap = buyer?.tradeVolume && buyer.tradeVolume > 0 ? buyer.tradeVolume : freeSpace;
    const units = Math.max(1, Math.min(freeSpace, affordable, volumeCap));
    try {
      await this.api.purchaseCargo(ship.symbol, feed.good, units);
      this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${ship.symbol} bought ${units}u @ ${price}c at ${t.market}`);
    } catch (err) {
      t.retryAt = Date.now() + 15_000;
      t.market = undefined;
      t.basePrice = undefined;
      this.log(`feed ${feed.good} → ${feed.targetWaypoint}: buy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async releaseFailedCarrier(feed: Feed, shipSymbol: string, t: FeedTaskState): Promise<void> {
    this.resume?.(shipSymbol);
    this.log(`feed ${feed.good} → ${feed.targetWaypoint}: released ${shipSymbol}, feed stays active for a new pick`);
    const idx = feed.assignedShips.indexOf(shipSymbol);
    if (idx !== -1) feed.assignedShips.splice(idx, 1);
    this.tasks.get(this.key(feed.targetWaypoint, feed.good))?.delete(shipSymbol);
    t.market = undefined;
    await this.persist(feed);
  }

  private async persist(f: Feed): Promise<void> {
    if (!this.tenantId) return;
    const key = this.key(f.targetWaypoint, f.good);
    await this.store?.recordFeed(this.tenantId, {
      targetSystem: f.targetSystem,
      targetWaypoint: f.targetWaypoint,
      good: f.good,
      assignedShips: f.assignedShips,
      carrierTarget: f.carrierTarget,
      paused: this.paused.has(key),
    });
  }
}
