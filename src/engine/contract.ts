import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { Store } from "../db/store.js";

export type Contract = components["schemas"]["Contract"];
export type ContractDeliverGood = components["schemas"]["ContractDeliverGood"];

/** Below this much runway, a contract isn't realistically flyable — one buy
 *  leg plus one delivery leg needs at least this much time even in the best
 *  case, so acceptBest() skips anything tighter rather than accepting a
 *  contract that's going to expire unfulfilled (and cost reputation for it). */
const MIN_DELIVERY_WINDOW_MS = 15 * 60_000;

/** Active delivery requirement of a contract. */
export interface Deliverable {
  contractId: string;
  tradeSymbol: string;
  unitsRequired: number;
  unitsFulfilled: number;
  destinationSymbol: string;
  deadline: string;
  /** The contract's onFulfilled payout — paid once as a lump sum when every
   *  deliverable across the whole contract is complete, not per unit or per
   *  deliverable. Lets a caller (fleet.ts's contractBuy prioritization)
   *  weight "finish this contract off" by what it's actually worth, instead
   *  of by how many units are left — which collapses toward zero right as
   *  a contract nears completion, exactly backwards from the real urgency. */
  onFulfilledPayment: number;
}

/** How long a fetched contract list stays good for. Contracts change on the
 *  order of minutes (accept, deliver, fulfill), and every one of those changes
 *  goes through this class, so the cache can be invalidated exactly rather than
 *  waited out. */
const CONTRACT_TTL_MS = 30_000;

/** Manages the agent's contracts: accept, track, deliver, fulfill. */
export class ContractManager {
  /** Contracts the operator declined: never auto-accepted, still listed. */
  private declined = new Set<string>();
  /**
   * The last fetched contract list.
   *
   * Without this, every caller of `listActive()` hit the API — and the
   * coordinator calls it twice per 2s tick (`fulfillCompleted` then
   * `acceptBest`), for the same payload, forever. That alone was 1 req/s of a
   * 2 req/s budget: half the fleet's entire API allowance spent re-reading a
   * list that changes a few times an hour.
   */
  private cache?: { at: number; contracts: Contract[] };

  /** Optional: lets acceptBest() weigh a contract's real sourcing cost, not
   *  just its raw payout. Absent in tests/contexts with no market intel yet —
   *  acceptBest() degrades to payout-only ranking rather than failing. */
  constructor(
    private readonly api: SpaceTradersAPI,
    private readonly store?: Store,
  ) {}

  /** Cheapest known market for a good, or undefined if none is known yet
   *  (also the normal case for a raw ore only obtainable by mining — those
   *  are never sold at any market). */
  private async cheapestMarket(tradeSymbol: string): Promise<{ waypoint: string; purchasePrice: number } | undefined> {
    if (!this.store) return undefined;
    const rows = (await this.store.latestMarketSnapshots()).filter((r) => r.goodSymbol === tradeSymbol && r.purchasePrice > 0);
    if (!rows.length) return undefined;
    const cheapest = rows.reduce((a, b) => (b.purchasePrice < a.purchasePrice ? b : a));
    return { waypoint: cheapest.waypointSymbol, purchasePrice: cheapest.purchasePrice };
  }

  /** The raw contract list, served from cache when fresh. */
  private async fetchContracts(): Promise<Contract[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CONTRACT_TTL_MS) return this.cache.contracts;
    const contracts = await this.api.getContracts();
    this.cache = { at: now, contracts };
    return contracts;
  }

  /** Drop the cache after any call that changes contract state server-side. */
  private invalidate(): void {
    this.cache = undefined;
  }

  /** Mark a contract as declined so the fleet never auto-accepts it. */
  decline(contractId: string): void {
    this.declined.add(contractId);
  }

  /** Undo a decline (the contract becomes auto-acceptable again). */
  undecline(contractId: string): void {
    this.declined.delete(contractId);
  }

  isDeclined(contractId: string): boolean {
    return this.declined.has(contractId);
  }

  listDeclined(): string[] {
    return [...this.declined];
  }

  async listActive(): Promise<Contract[]> {
    const all = await this.fetchContracts();
    const now = Date.now();
    return all.filter((c) => {
      if (c.fulfilled) return false;
      if (c.accepted) return new Date(c.terms.deadline).getTime() > now;
      return !c.deadlineToAccept || new Date(c.deadlineToAccept).getTime() > now;
    });
  }

  /**
   * Accept the most valuable *feasible* unaccepted contract, if any.
   *
   * Ranks by payout minus estimated sourcing cost, not raw payout alone —
   * previously this just took the highest onAccepted+onFulfilled contract
   * regardless of whether the fleet could actually source or deliver it in
   * time, which could accept a contract that then expires unfulfilled (a
   * real reputation cost, not just wasted upside).
   *
   * A deliverable with no known market isn't treated as unsourceable: raw
   * ores (the most common contract good early on) are only ever obtained by
   * mining, never sold anywhere, so "no market found" just means the cost
   * can't be priced in — it contributes nothing to the estimate rather than
   * disqualifying the contract.
   */
  async acceptBest(): Promise<Contract | undefined> {
    const active = await this.listActive();
    const unaccepted = active.filter((c) => !c.accepted && !this.declined.has(c.id));
    if (unaccepted.length === 0) return undefined;

    const now = Date.now();
    const scored: { contract: Contract; score: number }[] = [];
    for (const c of unaccepted) {
      const deadlineMs = new Date(c.terms.deadline).getTime() - now;
      if (deadlineMs < MIN_DELIVERY_WINDOW_MS) continue; // not enough runway to fly it at all
      const payout = c.terms.payment.onAccepted + c.terms.payment.onFulfilled;
      let sourcingCost = 0;
      for (const d of c.terms.deliver ?? []) {
        const needed = d.unitsRequired - d.unitsFulfilled;
        if (needed <= 0) continue;
        const cheapest = await this.cheapestMarket(d.tradeSymbol);
        if (cheapest) sourcingCost += cheapest.purchasePrice * needed;
      }
      scored.push({ contract: c, score: payout - sourcingCost });
    }
    if (scored.length === 0) return undefined;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!.contract;
    await this.api.acceptContract(best.id);
    this.invalidate();
    return best;
  }

  /**
   * Ask the HQ for a new contract via `shipSymbol` — presence at any
   * waypoint with a faction is all negotiating requires, not the flagship
   * or any particular role. Only ever useful when listActive() is empty:
   * the API allows at most one ongoing or offered contract at a time, and
   * rejects the call otherwise.
   */
  async negotiate(shipSymbol: string): Promise<Contract> {
    const { contract } = await this.api.negotiateContract(shipSymbol);
    this.invalidate();
    return contract;
  }

  /** Accept a specific contract by id. */
  async acceptById(contractId: string): Promise<Contract> {
    const active = await this.listActive();
    const contract = active.find((c) => c.id === contractId);
    if (!contract) throw new Error(`contract ${contractId} not found or expired`);
    if (contract.accepted) return contract;
    await this.api.acceptContract(contractId);
    this.invalidate();
    return { ...contract, accepted: true };
  }

  /** Deliveries still outstanding across all accepted contracts. */
  async outstandingDeliveries(): Promise<Deliverable[]> {
    const accepted = (await this.listActive()).filter((c) => c.accepted);
    const out: Deliverable[] = [];
    for (const c of accepted) {
      for (const d of c.terms.deliver ?? []) {
        if (d.unitsRequired - d.unitsFulfilled > 0) {
          out.push({
            contractId: c.id,
            tradeSymbol: d.tradeSymbol,
            unitsRequired: d.unitsRequired,
            unitsFulfilled: d.unitsFulfilled,
            destinationSymbol: d.destinationSymbol,
            deadline: c.terms.deadline,
            onFulfilledPayment: c.terms.payment.onFulfilled,
          });
        }
      }
    }
    return out;
  }

  /** Total units of `tradeSymbol` still outstanding across every accepted
   *  contract that wants it — lets a contractBuy purchase cap itself at what
   *  is actually still needed instead of the market's/cargo's/wallet's own
   *  limit, which can be well beyond it once a contract is mostly filled. */
  async outstandingUnitsFor(tradeSymbol: string): Promise<number> {
    const deliveries = await this.outstandingDeliveries();
    return deliveries.filter((d) => d.tradeSymbol === tradeSymbol).reduce((sum, d) => sum + (d.unitsRequired - d.unitsFulfilled), 0);
  }

  /**
   * Route a ship that holds contract goods: navigate to the delivery target
   * and deliver everything it can.
   * Returns: `true` if delivered, a destination symbol to fly to, or falsy if nothing to do.
   */
  async deliverVia(ship: components["schemas"]["Ship"]): Promise<true | string | null> {
    const deliveries = await this.outstandingDeliveries();
    const carried = new Set<string>(ship.cargo.inventory.map((i) => i.symbol));
    const relevant = deliveries.filter((d) => carried.has(d.tradeSymbol));
    if (relevant.length === 0) return null;

    for (const d of relevant) {
      // SpaceTraders reports nav.waypointSymbol as the destination for the
      // whole transit, not just on arrival — waypointSymbol alone can't
      // tell "flying there" from "there". Confirmed live: without the
      // status check, a ship woken mid-flight (before its real ETA) read as
      // arrived, and the delivery attempt below failed with "Ship is
      // currently in-transit ... and arrives in N seconds" every time it
      // woke early — trader.ts's own navigateTo() has the identical guard
      // for the same reason.
      if (ship.nav.waypointSymbol !== d.destinationSymbol || ship.nav.status === "IN_TRANSIT") {
        return d.destinationSymbol;
      }
    }
    // We're at the destination: deliver as much as we carry. Confirmed
    // live: under the scheduler-driven navigate flow, arrival is picked up
    // on a later, separate tick — this call is the very first thing that
    // tick does, before trader.ts's own ensureDocked() (which only runs on
    // the tick that *issues* the navigate, not the one that resumes after
    // it) ever gets a chance to dock the ship. Without this, deliverContract
    // failed every retry forever with "Ship action failed. Ship is not
    // currently docked", on a ship that had genuinely arrived and was just
    // sitting in orbit.
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
    const cargo = await this.api.getShipCargo(ship.symbol);
    for (const item of cargo.inventory) {
      const del = deliveries.find((d) => d.tradeSymbol === item.symbol);
      if (!del) continue;
      const toDeliver = Math.min(item.units, del.unitsRequired - del.unitsFulfilled);
      if (toDeliver > 0) {
        await this.api.deliverContract(del.contractId, ship.symbol, item.symbol, toDeliver);
        this.invalidate();
      }
    }
    return true;
  }

  /** Fulfill any accepted contracts that are complete. */
  async fulfillCompleted(): Promise<void> {
    const accepted = (await this.listActive()).filter((c) => c.accepted);
    for (const c of accepted) {
      const done = (c.terms.deliver ?? []).every((d) => d.unitsFulfilled >= d.unitsRequired);
      if (done) {
        await this.api.fulfillContract(c.id);
        this.invalidate();
      }
    }
  }

  /**
   * Trade symbols any currently accepted contract still needs delivered —
   * synchronous, unlike outstandingDeliveries(), because every
   * protectedGoods() call site across the fleet is a sync callback (mirrors
   * MissionManager.protectedGoods()' own in-memory set). Reads the last
   * fetched contract list (see fetchContracts()'s cache/TTL) rather than
   * making a fresh call — fulfillCompleted()/acceptBest() already refresh it
   * once per coordinator tick, which is fresh enough for "don't sell this".
   */
  protectedGoods(): Set<string> {
    const out = new Set<string>();
    for (const c of this.cache?.contracts ?? []) {
      if (!c.accepted || c.fulfilled) continue;
      for (const d of c.terms.deliver ?? []) {
        if (d.unitsRequired - d.unitsFulfilled > 0) out.add(d.tradeSymbol);
      }
    }
    return out;
  }
}
