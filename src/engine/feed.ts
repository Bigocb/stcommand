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
  /** Explicit operator choice: source this good by mining instead of buying
   *  at a market. Deliberately explicit rather than auto-detected — most
   *  raw ore has no market seller at all, but guessing "mineable" from that
   *  alone is unreliable, and the operator already knows which is which. */
  mine?: boolean;
  /** Pinned source market — when set, this tier always buys here instead of
   *  auto-picking the system's cheapest known seller. Set automatically for
   *  every non-first tier of a chain (see startChain()) to the previous
   *  tier's own `targetWaypoint`, so each step buys where the one before it
   *  sold, instead of each tier independently re-deriving "cheapest" and
   *  possibly landing on an unconnected market. Ignored when `mine` is true. */
  buyAt?: string;
  /** Chain membership (see startChain()/listChains()) — undefined for a
   *  standalone feed, unchanged from before chains existed. */
  chainId?: string;
  chainName?: string;
  /** Position within the chain, bottom tier (closest to raw material) first. */
  chainOrder?: number;
}

/** An ordered set of feeder tiers where each tier buys where the previous
 *  one sold — e.g. ore→H56→F50→D40. Not a separate persisted entity: a
 *  chain is just a shared `chainId` across several `Feed` rows, grouped on
 *  read (listChains()) and operated on as a unit (pause/resume/remove all
 *  member tiers together) via the plain per-feed operations underneath.
 *  Several chains can run at once, each independent. */
export interface FeedChain {
  chainId: string;
  name: string;
  targetSystem: string;
  tiers: Feed[];
}

/** Options for start()/startChain() tiers. */
export interface FeedStartOptions {
  carrierTarget?: number;
  mine?: boolean;
  buyAt?: string;
  chainId?: string;
  chainName?: string;
  chainOrder?: number;
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
  /** Record a real credits-moving transaction to the ledger. Confirmed live:
   *  stepCarrier()'s buy/sell used to call this.api.purchaseCargo()/
   *  sellCargo() directly, bypassing this entirely — every feed purchase and
   *  sell was invisible to ledger-based reconciliation. Same shape as
   *  mission.ts's own recordLedger option, wired from fleet.ts the same way. */
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
  getShip?: (symbol: string) => Promise<Ship>;
  estimatedFuelBetween?: (a: string, b: string) => number;
  canReach?: (shipSymbol: string, targetWaypoint: string) => Promise<boolean>;
  dispatchShip?: (shipSymbol: string, waypointSymbol: string) => Promise<void>;
  /** `requireMiner` is true for a "mine" feed — its crew must actually be
   *  able to mine (a plain trader would just spin, unable to source
   *  anything, since nothing sells the good). */
  pickCarrier?: (exclude: Set<string>, targetWaypoint?: string, requireMiner?: boolean) => Promise<string | undefined>;
  suspend?: (shipSymbol: string) => void | Promise<void>;
  resume?: (shipSymbol: string) => void;
  /** Sources known to sell a trade good in the given system, cheapest first. */
  listBuyers?: (tradeSymbol: string, systemSymbol: string) => Promise<{ waypoint: string; purchasePrice: number; tradeVolume: number }[]>;
  discoverBuyers?: (tradeSymbol: string, systemSymbol: string) => Promise<{ waypoint: string; purchasePrice: number }[]>;
  getCredits?: () => Promise<number>;
  sellCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
  jettisonCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
  /** Mine one batch of the feed's good for this ship, if it has a mining
   *  mount and a reachable asteroid — the fallback source when nothing
   *  sells the good (raw ore, typically). Returns true if it did anything
   *  (mined or relocated toward an asteroid), false if this ship can't mine
   *  or has nowhere to mine from right now. */
  mineOnce?: (shipSymbol: string) => Promise<boolean>;
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
  private readonly recordLedger?: FeedOptions["recordLedger"];
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
  private readonly mineOnce?: FeedOptions["mineOnce"];

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
    this.mineOnce = opts.mineOnce;
  }

  private key(targetWaypoint: string, good: string): string {
    return `${targetWaypoint}::${good}`;
  }

  /** Start (or resume, if already persisted) a feeder tier. */
  async start(targetWaypoint: string, good: string, opts: FeedStartOptions = {}): Promise<void> {
    const carrierTarget = opts.carrierTarget ?? 1;
    const key = this.key(targetWaypoint, good);
    // A feed already running under this exact (targetWaypoint, good) — most
    // commonly startChain() naming a tier the operator had already started
    // standalone. A plain re-call (opts.chainId undefined) stays the
    // no-op it always was; a chain call ADOPTS this feed into the chain
    // instead of silently doing nothing, which is what used to happen here
    // and is exactly why a chain built from already-running tiers "saved"
    // (startChain()'s own log line fired) but no tier actually carried the
    // new chainId — confirmed live 2026-09-25.
    const existing = this.active.get(key);
    if (existing) {
      if (opts.chainId !== undefined) {
        existing.chainId = opts.chainId;
        existing.chainName = opts.chainName;
        existing.chainOrder = opts.chainOrder;
        if (opts.buyAt !== undefined) existing.buyAt = opts.buyAt;
        if (opts.mine !== undefined) existing.mine = opts.mine;
        // Force the running carrier(s) to re-pick their source next tick —
        // they may already have locked onto a different market before
        // being adopted into this chain.
        for (const t of this.tasks.get(key)?.values() ?? []) {
          t.market = undefined;
          t.basePrice = undefined;
        }
        await this.persist(existing);
        this.log(`feed ${good} → ${targetWaypoint}: adopted into chain ${opts.chainName ?? opts.chainId}`);
      }
      return;
    }
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
        mine: opts.mine ?? persisted.mine,
        buyAt: opts.buyAt ?? persisted.buyAt ?? undefined,
        chainId: opts.chainId ?? persisted.chainId ?? undefined,
        chainName: opts.chainId !== undefined ? opts.chainName : (persisted.chainName ?? undefined),
        chainOrder: opts.chainId !== undefined ? opts.chainOrder : (persisted.chainOrder ?? undefined),
      };
      this.active.set(key, feed);
      if (persisted.paused) {
        this.paused.add(key);
        if (opts.chainId !== undefined) await this.persist(feed);
        this.log(`feed resumed (from prior state, PAUSED): ${good} → ${targetWaypoint}`);
        return;
      }
      const shipTasks = new Map<string, FeedTaskState>();
      for (const s of feed.assignedShips) {
        shipTasks.set(s, { retryAt: 0 });
        await this.suspend?.(s);
      }
      this.tasks.set(key, shipTasks);
      if (opts.chainId !== undefined) await this.persist(feed);
      this.log(`feed resumed (from prior state): ${good} → ${targetWaypoint}`);
      return;
    }
    const feed: Feed = {
      targetSystem: system, good, targetWaypoint,
      assignedShips: [],
      carrierTarget,
      mine: opts.mine,
      buyAt: opts.buyAt,
      chainId: opts.chainId,
      chainName: opts.chainName,
      chainOrder: opts.chainOrder,
    };
    this.active.set(key, feed);
    this.tasks.set(key, new Map());
    await this.persist(feed);
    this.log(`feed started: ${good} → ${targetWaypoint} (crew target ${carrierTarget}, source: ${feed.mine ? "mine" : feed.buyAt ? `buy @ ${feed.buyAt}` : "buy (cheapest known)"})`);
    this.onActivity?.("feed", `feeder started: ${good} → ${targetWaypoint}`, 0, undefined);
  }

  /**
   * Start a chain of feeder tiers, bottom-to-top: each tier after the first
   * has its buyAt pinned to the previous tier's own targetWaypoint, so the
   * chain actually connects (buys where the last tier sold) instead of each
   * tier independently re-deriving "cheapest known market" and possibly
   * landing on an unconnected one. The first tier sources by mining (if
   * `mine` is set) or an operator-given `buyAt`, same as a standalone feed.
   * Several chains can run at once — each gets its own chainId, and nothing
   * here assumes only one exists.
   */
  async startChain(name: string, tiers: { good: string; sellAt: string; mine?: boolean; buyAt?: string; carrierTarget?: number }[]): Promise<string> {
    if (tiers.length === 0) throw new Error("a chain needs at least one tier");
    const chainId = `chain_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let prevSellAt: string | undefined;
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i]!;
      await this.start(tier.sellAt, tier.good, {
        carrierTarget: tier.carrierTarget,
        mine: tier.mine,
        buyAt: i === 0 ? tier.buyAt : prevSellAt,
        chainId, chainName: name, chainOrder: i,
      });
      prevSellAt = tier.sellAt;
    }
    this.log(`chain started: ${name} (${chainId}), ${tiers.length} tier${tiers.length === 1 ? "" : "s"}`);
    return chainId;
  }

  /** Chains, grouped from their member feeds' shared chainId, ordered
   *  bottom tier first. Standalone feeds (no chainId) aren't included —
   *  see list() for those. */
  async listChains(): Promise<FeedChain[]> {
    const all = await this.list();
    const grouped = new Map<string, Feed[]>();
    for (const f of all) {
      if (!f.chainId) continue;
      const arr = grouped.get(f.chainId) ?? [];
      arr.push(f);
      grouped.set(f.chainId, arr);
    }
    return [...grouped.entries()].map(([chainId, tiers]) => {
      tiers.sort((a, b) => (a.chainOrder ?? 0) - (b.chainOrder ?? 0));
      return { chainId, name: tiers[0]?.chainName ?? chainId, targetSystem: tiers[0]?.targetSystem ?? "", tiers };
    });
  }

  /** Pause every tier of a chain as one unit. */
  async pauseChain(chainId: string): Promise<void> {
    for (const t of (await this.list()).filter((f) => f.chainId === chainId)) await this.pause(t.targetWaypoint, t.good);
  }

  /** Resume every tier of a paused chain as one unit. */
  async resumeChain(chainId: string): Promise<void> {
    for (const t of (await this.list()).filter((f) => f.chainId === chainId)) await this.resumeFeed(t.targetWaypoint, t.good);
  }

  /** Stop and forget every tier of a chain — like remove(), not pause(). */
  async removeChain(chainId: string): Promise<void> {
    for (const t of (await this.list()).filter((f) => f.chainId === chainId)) await this.remove(t.targetWaypoint, t.good);
  }

  /** Full list of known feeds (standalone and chain tiers alike). */
  async list(): Promise<Feed[]> {
    const rows = this.tenantId ? await this.store?.latestFeeds(this.tenantId) : undefined;
    const persisted: Feed[] = (rows ?? []).map((f) => ({
      targetSystem: f.targetSystem,
      targetWaypoint: f.targetWaypoint,
      good: f.good,
      assignedShips: f.assignedShips,
      carrierTarget: f.carrierTarget,
      paused: f.paused,
      mine: f.mine,
      buyAt: f.buyAt ?? undefined,
      chainId: f.chainId ?? undefined,
      chainName: f.chainName ?? undefined,
      chainOrder: f.chainOrder ?? undefined,
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
      // A "mine" feed has no market seller to check by definition, and a
      // pinned buyAt (chain tier) is sourceable by construction — the
      // buyer-discovery gate below only applies to a plain buy feed picking
      // its own cheapest market, where it avoids assigning a carrier to a
      // good nothing sells yet.
      const sourceable = feed.mine || !!feed.buyAt || ((await this.listBuyers?.(feed.good, feed.targetSystem)) ?? []).length > 0;
      if (!sourceable) {
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
        const carrier = await this.pickCarrier?.(this.committedShips(), feed.targetWaypoint, feed.mine);
        if (carrier) {
          feed.assignedShips.push(carrier);
          shipTasks.set(carrier, { retryAt: 0 });
          await this.suspend?.(carrier);
          this.log(`feed ${feed.good} → ${feed.targetWaypoint}: assigned carrier ${carrier} (${feed.assignedShips.length}/${feed.carrierTarget})`);
          await this.persist(feed);
          this.onActivity?.("feed", `assigned ${carrier} to feed ${feed.good} → ${feed.targetWaypoint}`, 0, carrier);
        }
        // A failed pick here used to be silent — see pickFeedCarrier()'s own
        // comment in fleet.ts (the actual injected pickCarrier callback) for
        // the throttled diagnostic that now covers it.
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
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: ship.symbol,
          waypointSymbol: feed.targetWaypoint,
          type: "SELL",
          tradeSymbol: feed.good,
          units: held,
          pricePerUnit: res.transaction.pricePerUnit,
          total: res.transaction.totalPrice,
        });
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

    // Empty-handed: source the good. An operator-flagged "mine" feed always
    // mines — no market lookup at all, since most raw ore has no seller
    // anyway and the flag is an explicit choice, not a fallback guess.
    if (feed.mine) {
      // `held` above only counts feed.good — a hold that's full of the
      // asteroid's OTHER deposits (this feed mines an asteroid with several
      // ore types, only one of which is the target) reads as "empty-handed"
      // here and falls straight into mining again, but mineOnce() has no
      // room to extract into and no-ops every call while still reporting
      // success (extractUntilFull()'s loop just never executes when
      // cargoFree() is 0). Confirmed live: THEO-27/29/2C sat full of
      // COPPER_ORE/ALUMINUM_ORE/SILICON_CRYSTALS — zero IRON_ORE — for 48+
      // minutes, silently re-logging "mining at .../using survey at ..."
      // every cycle with nothing ever extracted, which is exactly why the
      // H56 market never moved no matter how long the feed "ran." The buy
      // branch already clears a full-but-wrong-good hold before sourcing
      // (see the freeSpace<=0 check below it); mining needs the same clear.
      const freeSpace = ship.cargo.capacity - ship.cargo.units;
      if (freeSpace <= 0) {
        await this.clearUnrelatedCargo(ship.symbol, feed.good, ship.cargo.inventory);
        return;
      }
      const mined = await this.mineOnce?.(shipSymbol);
      if (!mined) t.retryAt = Date.now() + 15_000;
      return;
    }
    // Otherwise pick a source market if we don't already have one — a
    // pinned buyAt (this tier is part of a chain: buy where the previous
    // tier sold) always wins over the cheapest-known-market auto-pick, so
    // the chain actually stays connected instead of drifting to whichever
    // market happens to be cheapest system-wide.
    if (!t.market) {
      if (feed.buyAt) {
        t.market = feed.buyAt;
        const buyers = (await this.listBuyers?.(feed.good, feed.targetSystem)) ?? [];
        t.basePrice = buyers.find((b) => b.waypoint === feed.buyAt)?.purchasePrice;
      } else {
        // Exclude the feed's own sell target from the cheapest-known-market
        // pick. Confirmed live: a feed selling into a market it also (once
        // in a while, or always) buys that same good at can drive that
        // market's buy price down far enough, via its own selling, that on
        // the next cycle "cheapest known market" picks the target itself —
        // buying back the exact good it just delivered, at a markup, in an
        // in-place loop that never travels anywhere and burns cash every
        // cycle (THEO-6/IRON/X1-SN30-F50, 2026-09-25: -6,780c every ~90s,
        // dozens of cycles, no travel between them — the sell price and the
        // very next buy price were the same market's own numbers).
        const buyers = ((await this.listBuyers?.(feed.good, feed.targetSystem)) ?? []).filter((b) => b.waypoint !== feed.targetWaypoint);
        if (buyers.length === 0) {
          t.retryAt = Date.now() + 15_000;
          return;
        }
        t.market = buyers[0]!.waypoint;
        t.basePrice = buyers[0]!.purchasePrice;
      }
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
      const res = await this.api.purchaseCargo(ship.symbol, feed.good, units);
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: ship.symbol,
        waypointSymbol: sourceMarket,
        type: "PURCHASE",
        tradeSymbol: feed.good,
        units,
        pricePerUnit: res.transaction.pricePerUnit,
        total: res.transaction.totalPrice,
      });
      this.log(`feed ${feed.good} → ${feed.targetWaypoint}: ${ship.symbol} bought ${units}u @ ${price}c at ${t.market}`);
      this.onActivity?.("buy", `${ship.symbol} ${units}u ${feed.good} @ ${res.transaction.pricePerUnit}c at ${sourceMarket} (feed)`, -res.transaction.totalPrice, ship.symbol);
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
      mine: f.mine ?? false,
      buyAt: f.buyAt,
      chainId: f.chainId,
      chainName: f.chainName,
      chainOrder: f.chainOrder,
    });
  }
}
