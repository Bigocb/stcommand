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
 *  waited out. Two minutes, not 30 s: measured 2026-10-22, the 30 s refetch cost about 4 calls a minute of the 90 a minute
 *  the rate limiter allows, for a list that only changes when this class changes it. */
const CONTRACT_TTL_MS = 120_000;

/**
 * The cache lifetime once the operator has stood every open contract down (abandoned an accepted one, declined an
 * offer). Nothing is being delivered, so nothing changes the list from our side — it was still re-read every 30s for
 * as long as the contract sat there. The deadline passing needs no polling to notice: an expired contract stops
 * counting as open, which ends the stood-down state and the next read goes out at the normal cadence. Operator
 * decisions invalidate the cache at once. So this is only a safety net against drift nothing here can see.
 */
const STAND_DOWN_TTL_MS = 60 * 60_000;

/** Manages the agent's contracts: accept, track, deliver, fulfill. */
export class ContractManager {
  /** Contracts the operator declined: never auto-accepted, still listed. */
  private declined = new Set<string>();
  /**
   * Contracts the operator accepted and then chose to stop working.
   *
   * The SpaceTraders API has accept, deliver, fulfil and negotiate — and no
   * cancel. An accepted contract cannot be handed back; it can only be
   * completed or allowed to lapse. So "abandon" here means exactly one thing,
   * and the UI says so rather than offering a Cancel button that implies
   * something the API cannot do: **stop sourcing for it.** The contract stays
   * accepted, stays listed, and lapses at its own deadline at the usual
   * reputation cost.
   *
   * Enforced in one place — outstandingDeliveries() — because that is the
   * single source every sourcing path reads: computeContractBuyTargets()
   * builds its targets from it, so the good stops being dispatched, and
   * releaseFulfilledManualContractBuys() then clears any manual assignment
   * pinned to it on the same tick. One filter, not a flag re-checked at four
   * call sites that can each forget it.
   *
   * fulfillCompleted() deliberately does NOT filter on this. Standing down
   * means refusing to spend more on a contract, not refusing money already
   * earned — if an abandoned contract is somehow complete, take the payout.
   */
  private abandoned = new Set<string>();
  /** Offers already logged as skipped for an unreachable delivery point, so it is said once, not on every pass. */
  private declinedUnreachable = new Set<string>();
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
    private readonly tenantId?: string,
    private readonly report: {
      log?: (msg: string) => void;
      onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
      recordLedger?: (entry: {
        timestamp: string; shipSymbol: string; waypointSymbol: string;
        type: string; tradeSymbol?: string; units?: number; pricePerUnit?: number; total: number; contractId?: string;
      }) => void;
      /** Cost basis per unit of a good a ship is carrying (what it paid for it), so a delivery can be costed. Undefined for
       *  mined or transferred cargo, which is then costed at 0. */
      costBasisOf?: (shipSymbol: string, good: string) => Promise<number | undefined>;
    } = {},
  ) {}

  private say(msg: string): void {
    this.report.log?.(msg);
  }

  /** Cheapest known unit price for a good, for estimating what finishing a contract will cost. Undefined when no market sells it. */
  async cheapestPriceFor(tradeSymbol: string): Promise<number | undefined> {
    return (await this.cheapestMarket(tradeSymbol))?.purchasePrice;
  }

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
    const ttl = this.cache && this.allStoodDown(this.cache.contracts, now) ? STAND_DOWN_TTL_MS : CONTRACT_TTL_MS;
    if (this.cache && now - this.cache.at < ttl) return this.cache.contracts;
    const contracts = await this.api.getContracts();
    this.cache = { at: now, contracts };
    return contracts;
  }

  /**
   * True when there is at least one open contract and every open one is something the operator told us not to work:
   * an accepted contract that was abandoned, or an offer that was declined. With none open at all the fleet wants
   * to negotiate a new one, so that is not "stood down".
   */
  private allStoodDown(contracts: Contract[], now: number): boolean {
    const open = contracts.filter((c) => {
      if (c.fulfilled) return false;
      if (c.accepted) return new Date(c.terms.deadline).getTime() > now;
      return !c.deadlineToAccept || new Date(c.deadlineToAccept).getTime() > now;
    });
    return open.length > 0 && open.every((c) => (c.accepted ? this.abandoned.has(c.id) : this.declined.has(c.id)));
  }

  /** Drop the cache after any call that changes contract state server-side. */
  private invalidate(): void {
    this.cache = undefined;
  }

  /** Mark a contract as declined so the fleet never auto-accepts it. */
  async decline(contractId: string): Promise<void> {
    this.declined.add(contractId);
    this.invalidate();
    await this.persistOperatorState();
  }

  /** Undo a decline (the contract becomes auto-acceptable again). */
  async undecline(contractId: string): Promise<void> {
    this.declined.delete(contractId);
    this.invalidate();
    await this.persistOperatorState();
  }

  isDeclined(contractId: string): boolean {
    return this.declined.has(contractId);
  }

  /**
   * Stop working an accepted contract: the fleet stops sourcing its goods and
   * releases any trader assigned to them. Not a cancel — see `abandoned`.
   */
  async abandon(contractId: string): Promise<void> {
    this.abandoned.add(contractId);
    this.invalidate();
    this.say(`contract ${contractId.slice(0, 8)}: no longer being worked (operator) — it will lapse at its deadline`);
    await this.persistOperatorState();
  }

  /** Resume working a contract that was stood down. */
  async resume(contractId: string): Promise<void> {
    this.abandoned.delete(contractId);
    this.invalidate();
    this.say(`contract ${contractId.slice(0, 8)}: back in work (operator)`);
    await this.persistOperatorState();
  }

  isAbandoned(contractId: string): boolean {
    return this.abandoned.has(contractId);
  }

  /** The goods one contract still wants, abandoned or not — so a caller can
   *  release the traders pinned to them. Reads the contract directly rather
   *  than outstandingDeliveries(), which by design no longer lists it. */
  async deliverablesFor(contractId: string): Promise<string[]> {
    const c = (await this.listActive()).find((x) => x.id === contractId);
    return [...new Set((c?.terms.deliver ?? []).map((d) => d.tradeSymbol))];
  }

  /**
   * Both operator decisions, persisted as one small JSON blob under the same
   * `fleet_flags` mechanism shipManualState already uses.
   *
   * This is not decoration. `declined` was in-memory only, and this service
   * redeploys on every push — so an operator declining a contract had that
   * decision silently discarded minutes later, and the fleet was free to
   * auto-accept the very contract they had just refused. A decision an
   * operator makes has to outlive the process that took it.
   */
  private async persistOperatorState(): Promise<void> {
    if (!this.store || !this.tenantId) return;
    await this.store.setFleetFlag(
      this.tenantId,
      "contractOperatorState",
      JSON.stringify({ declined: [...this.declined], abandoned: [...this.abandoned] }),
    );
  }

  /** Replay the operator's decisions at boot. Call once, before the first tick. */
  async loadOperatorState(): Promise<void> {
    if (!this.store || !this.tenantId) return;
    const raw = await this.store.getFleetFlag(this.tenantId, "contractOperatorState");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { declined?: string[]; abandoned?: string[] };
      this.declined = new Set(parsed.declined ?? []);
      this.abandoned = new Set(parsed.abandoned ?? []);
      if (this.abandoned.size) this.say(`contracts: ${this.abandoned.size} stood down by the operator, not being worked`);
    } catch {
      // A corrupt blob must not stop the fleet booting, and must not pass
      // silently either — the operator can set the decisions again.
      this.say("contracts: operator state could not be read, starting with none");
    }
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
   * Whether a delivery point can be reached by gate from where cargo is bought. Set by the fleet, which owns the gate graph; absent
   * (tests, contexts with no atlas) every delivery counts as reachable and contracts behave exactly as before.
   */
  private deliveryReachable?: (destinationSymbol: string) => Promise<boolean>;
  setDeliveryReachable(fn: ((destinationSymbol: string) => Promise<boolean>) | undefined): void {
    this.deliveryReachable = fn;
  }

  /** The first outstanding delivery of a contract that cannot be reached, or undefined when all can (or reachability is not known). */
  async unreachableDelivery(c: Contract): Promise<string | undefined> {
    if (!this.deliveryReachable) return undefined;
    for (const d of c.terms.deliver ?? []) {
      if (d.unitsRequired - d.unitsFulfilled <= 0) continue;
      if (!(await this.deliveryReachable(d.destinationSymbol))) return d.destinationSymbol;
    }
    return undefined;
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
      // A delivery point past the gate ceiling is not a contract worth the advance: nothing here could ever deliver it
      // (2026-10-22: 132 PRECIOUS_STONES to X1-NH60-ZA5E, 21 jumps from home, owing 17k, left a ship stuck for two hours).
      const unreachable = await this.unreachableDelivery(c);
      if (unreachable !== undefined) {
        if (!this.declinedUnreachable.has(c.id)) {
          this.declinedUnreachable.add(c.id);
          this.say(`contract ${c.id} not accepted: it delivers to ${unreachable}, which has no verified gate path from here`);
        }
        continue;
      }
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
    this.recordAdvance(best);
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

  /** The credits a contract pays the moment it is accepted. They land in the wallet with no other trace, so without this row the
   *  ledger understated every contract's income by its advance. */
  private recordAdvance(c: Contract): void {
    const advance = c.terms.payment?.onAccepted ?? 0;
    if (advance <= 0) return;
    this.report.recordLedger?.({
      timestamp: new Date().toISOString(), shipSymbol: "fleet", waypointSymbol: "", type: "CONTRACT",
      tradeSymbol: "ADVANCE", total: advance, contractId: c.id,
    });
  }

  /** Accept a specific contract by id. */
  async acceptById(contractId: string): Promise<Contract> {
    const active = await this.listActive();
    const contract = active.find((c) => c.id === contractId);
    if (!contract) throw new Error(`contract ${contractId} not found or expired`);
    if (contract.accepted) return contract;
    await this.api.acceptContract(contractId);
    this.invalidate();
    this.recordAdvance(contract);
    return { ...contract, accepted: true };
  }

  /** Deliveries still outstanding across all accepted contracts. */
  async outstandingDeliveries(): Promise<Deliverable[]> {
    // The one place "stop working this contract" is enforced — see `abandoned`.
    const accepted = (await this.listActive()).filter((c) => c.accepted && !this.abandoned.has(c.id));
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

  /**
   * What the accepted contracts still pay for the units of `tradeSymbol` they still need: the units, and the payment owed on completion
   * shared out by units when a contract has several lines. An advance already received is not counted. For the contract buy guard.
   */
  async outstandingRewardFor(tradeSymbol: string): Promise<{ units: number; payout: number }> {
    const all = await this.outstandingDeliveries();
    const perContract = new Map<string, number>();
    for (const d of all) perContract.set(d.contractId, (perContract.get(d.contractId) ?? 0) + (d.unitsRequired - d.unitsFulfilled));
    let units = 0;
    let payout = 0;
    for (const d of all) {
      if (d.tradeSymbol !== tradeSymbol) continue;
      const remaining = d.unitsRequired - d.unitsFulfilled;
      units += remaining;
      payout += (d.onFulfilledPayment * remaining) / (perContract.get(d.contractId) || remaining);
    }
    return { units, payout };
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
        // A delivery moves goods, not credits, so there is no ledger row —
        // but it is the single most consequential thing the fleet does, and
        // until now it happened in total silence. Three units of DRUGS worth
        // 33,492c left a hold with no log line, no activity entry and no
        // trace of any kind; from outside, "delivered against the contract"
        // and "destroyed by a bug" looked identical, and establishing which
        // took a source read and a timestamp cross-reference. The progress
        // count is the part that matters: it says whether this contract is
        // nearly done or barely started.
        // The goods leave the hold here, so this is where their cost leaves the books' open positions: a DELIVERY row
        // (units and cost basis, total 0 because it is not cash) lets the metrics net the contract's income against it.
        const basis = await this.report.costBasisOf?.(ship.symbol, item.symbol).catch(() => undefined);
        this.report.recordLedger?.({
          timestamp: new Date().toISOString(), shipSymbol: ship.symbol, waypointSymbol: del.destinationSymbol, type: "DELIVERY",
          tradeSymbol: item.symbol, units: toDeliver, pricePerUnit: basis, total: 0, contractId: del.contractId,
        });
        const done = del.unitsFulfilled + toDeliver;
        this.say(
          `${ship.symbol}: delivered ${toDeliver}u ${item.symbol} to contract ${del.contractId.slice(0, 8)} ` +
          `at ${del.destinationSymbol} (${done}/${del.unitsRequired})`,
        );
        this.report.onActivity?.(
          "contract-deliver",
          `${toDeliver}u ${item.symbol} → contract (${done}/${del.unitsRequired})`,
          undefined,
          ship.symbol,
        );
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
        // Unlike a delivery this *is* money — the whole payout, landing at
        // once — and it was as silent as the deliveries that earned it. With
        // no ledger row the payout never reached ledgerSummary(), so every
        // earnings readout showed the cost of buying contract goods with
        // nothing on the other side: the fleet's largest single revenue event
        // was missing from its own books, and a run that made money could
        // read as one losing it.
        const payout = c.terms.payment?.onFulfilled ?? 0;
        this.say(`contract ${c.id.slice(0, 8)} fulfilled — ${payout}c paid`);
        this.report.onActivity?.("contract-fulfilled", `contract paid out ${payout}c`, payout, "fleet");
        this.report.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          waypointSymbol: "",
          type: "CONTRACT",
          tradeSymbol: "PAYOUT",
          total: payout,
          contractId: c.id,
        });
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
   *
   * Must skip `abandoned` contracts exactly like outstandingDeliveries()
   * does — confirmed live: an operator-abandoned IRON_ORE contract kept its
   * good in this set forever (this method never checked `abandoned` at
   * all), while deliverVia() (built on outstandingDeliveries(), which does
   * check it) refused to route it anywhere. Two miners that incidentally
   * mined IRON_ORE at a shared asteroid filled their holds with a good that
   * could never be sold, jettisoned, or delivered — no seller, no route, no
   * bug in either check alone, just the two disagreeing about one contract.
   */
  protectedGoods(): Set<string> {
    const out = new Set<string>();
    for (const c of this.cache?.contracts ?? []) {
      if (!c.accepted || c.fulfilled || this.abandoned.has(c.id)) continue;
      for (const d of c.terms.deliver ?? []) {
        if (d.unitsRequired - d.unitsFulfilled > 0) out.add(d.tradeSymbol);
      }
    }
    return out;
  }
}
