import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { Registry } from "./registry.js";
import type { GalaxyAtlas } from "./galaxy.js";
import type { Store } from "../db/store.js";
import { type AgentStep, IDLE_STEP, NavigationPending, CooldownPending } from "./agentStep.js";
import { chooseFlightMode, flightModeReason } from "./flightMode.js";
import { supersedes, type ShipIntent } from "./intent.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ShipProxyOptions {
  api: SpaceTradersAPI;
  registry: Registry;
  log?: (msg: string) => void;
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Repair this ship where it now stands; wired to FleetManager.repairShip(). */
  repairHere?: (shipSymbol: string) => Promise<void>;
  /** Records a refuel purchase against the tenant's ledger. Typed exactly as
   *  the agents' own callback so it can be passed straight through. */
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "PURCHASE" | "SELL" | "REFUEL";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** GalaxyAtlas instance for runExploreGoal to survey markets in the target system. */
  galaxy?: GalaxyAtlas;
  /** Store for runExploreGoal to record module catalogs and shipyard data. */
  store?: Store;
  /** Called by runExploreGoal/runTenderGoal when the goal is complete. */
  done?: () => void;
}

/**
 * The one set of movement primitives every ship role shares —
 * `docs/control-plane-data-plane.md` §5, the "kubelet" half of the split.
 *
 * Before this, `agent.ts`, `scout.ts`, `siphoner.ts` and `trader.ts` each
 * carried a private copy of `ensureInOrbit`/`ensureDocked`/`waitForArrival`/
 * `waitCooldown`/`navigateTo`, and those copies had demonstrably drifted:
 *
 *   - only `agent.ts` re-checked arrival *after* `ensureInOrbit()`, so the
 *     other three fired a second, redundant navigate at a waypoint the ship
 *     had just been confirmed to be standing on;
 *   - only `agent.ts` matched the live API's real "is currently located at
 *     the destination" wording. `siphoner.ts` still tested for
 *     "already located at the destination", which that same comment in
 *     `agent.ts` records as *not matching what the server actually says* —
 *     so a genuine already-there response was being reported as a navigation
 *     failure;
 *   - `siphoner.ts` returned a boolean where the others threw, which is how
 *     it once swallowed a `NavigationPending` into `return false`.
 *
 * Fixing any one of those in one file left the others wrong. There is now a
 * single implementation, and it is the merged best of the four.
 *
 * The owning agent keeps its `this.ship` accessor pointed here (a getter/
 * setter pair over `getShip()`/`setShip()`), so every existing read and
 * write in those classes goes on working untouched while there is only one
 * copy of the state.
 */

// Phase states for runExploreGoal. Defined at module scope since TypeScript
// does not permit enum declarations inside class bodies.
const enum ExplorePhase { GATE = "gate", JUMP = "jump", SURVEY = "survey", MARKET = "market", DONE = "done" }
// Phase states for runTenderGoal.
const enum TenderPhase { BUY = "buy", TRANSIT = "transit", TRANSFER = "transfer", DONE = "done" }

export class ShipProxy {
  private ship: Ship;
  private readonly api: SpaceTradersAPI;
  private registry: Registry;
  private readonly log: (msg: string) => void;
  private readonly onActivity?: ShipProxyOptions["onActivity"];
  private readonly recordMarket?: ShipProxyOptions["recordMarket"];
  private readonly repairHere?: ShipProxyOptions["repairHere"];
  private readonly recordLedger?: ShipProxyOptions["recordLedger"];
  private readonly galaxy?: GalaxyAtlas;
  private readonly store?: Store;
  private readonly done?: () => void;
  private step: AgentStep = IDLE_STEP;

  /**
   * True only for the duration of a scheduler `Task.run()` call. While set,
   * anything that would wait — a transit, a cooldown, a short retry backoff —
   * throws a `Pending` carrying the real resume time instead of sleeping, so
   * one ship's wait never occupies the sequential task runner. A manual
   * `dispatchTo()` leaves it false and keeps blocking exactly as before.
   */
  schedulerDriven = false;

  /** Phase for runExploreGoal, keyed by ship symbol (one ship can have only one active explore). */
  private explorePhase = new Map<string, ExplorePhase>();
  /** Market index during the MARKET phase of explore — separate from phase so the Map stays type-safe. */
  private exploreMarketIndex = new Map<string, number>();
  /** Phase for runTenderGoal, keyed by ship symbol. */
  private tenderPhase = new Map<string, TenderPhase>();

  constructor(ship: Ship, opts: ShipProxyOptions) {
    this.ship = ship;
    this.api = opts.api;
    this.registry = opts.registry;
    this.log = opts.log ?? (() => {});
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.repairHere = opts.repairHere;
    this.recordLedger = opts.recordLedger;
    this.galaxy = opts.galaxy;
    this.store = opts.store;
    this.done = opts.done;
  }

  get symbol(): string {
    return this.ship.symbol;
  }

  getShip(): Ship {
    return this.ship;
  }

  setShip(ship: Ship): void {
    this.ship = ship;
  }

  getStep(): AgentStep {
    return this.step;
  }

  setStep(step: AgentStep): void {
    this.step = step;
  }

  /** Point this proxy at a different live world — the fleet's shared registry
   *  arrives after construction, via each agent's own withRegistry(). */
  setRegistry(registry: Registry): void {
    this.registry = registry;
  }

  async refresh(): Promise<void> {
    this.ship = await this.api.getShip(this.ship.symbol);
  }

  /** Wait out an action cooldown, or yield the scheduler until it expires. */
  async waitCooldown(): Promise<void> {
    const cd = this.ship.cooldown;
    if (!cd || cd.remainingSeconds <= 0) return;
    if (this.schedulerDriven) throw new CooldownPending(Date.now() + cd.remainingSeconds * 1000 + 250);
    this.log(`cooldown ${cd.remainingSeconds}s`);
    await sleep(cd.remainingSeconds * 1000 + 250);
    await this.refresh();
  }

  /** A short retry backoff that yields the scheduler rather than blocking it. */
  async pause(ms: number): Promise<void> {
    if (this.schedulerDriven) throw new CooldownPending(Date.now() + ms, "backoff");
    await sleep(ms);
    await this.refresh();
  }

  async ensureInOrbit(): Promise<void> {
    if (this.ship.nav.status === "IN_ORBIT") return;
    if (this.ship.nav.status === "IN_TRANSIT") await this.waitForArrival();
    if (this.ship.nav.status === "DOCKED") {
      this.log("docking → orbit");
      await this.api.orbitShip(this.ship.symbol);
      await this.refresh();
    }
  }

  async ensureDocked(): Promise<void> {
    if (this.ship.nav.status === "DOCKED") return;
    if (this.ship.nav.status === "IN_TRANSIT") await this.waitForArrival();
    if (this.ship.nav.status === "IN_ORBIT") {
      this.log("orbit → dock");
      await this.api.dockShip(this.ship.symbol);
      await this.refresh();
      // Prices are only visible to a ship physically present and docked, so
      // this is the one moment they can be captured. Recording here rather
      // than at each call site is why a dock anywhere refreshes the world.
      if (this.recordMarket) await this.recordMarket(this.ship.nav.waypointSymbol);
    }
  }

  /** Wait until the ship has finished its current transit, or yield until arrival. */
  async waitForArrival(): Promise<void> {
    if (this.schedulerDriven) {
      // Always refresh before deciding: whatever route this.ship currently
      // holds is not guaranteed to be from *this* transit, and a single
      // non-blocking check has no retry loop to self-correct the way the
      // blocking branch below does.
      await this.refresh();
      if (this.ship.nav.status !== "IN_TRANSIT") return;
      const wait = new Date(this.ship.nav.route.arrival).getTime() - Date.now();
      throw new NavigationPending(Date.now() + wait);
    }
    for (;;) {
      const arrival = new Date(this.ship.nav.route.arrival).getTime();
      const wait = arrival - Date.now();
      if (wait > 0) {
        this.log(`in transit, arrival in ${Math.round(wait / 1000)}s`);
        await sleep(wait + 1000);
      }
      await this.refresh();
      if (this.ship.nav.status !== "IN_TRANSIT") return;
    }
  }

  /**
   * Fly to a waypoint in this system, picking a flight mode first.
   *
   * Throws `NavigationPending` when scheduler-driven and the ship is still in
   * flight; throws the underlying error on a real rejection. Callers that
   * want a boolean wrap this themselves — see `SiphonerAgent.navigateTo()`.
   */
  async navigateTo(waypoint: string): Promise<void> {
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") return;
    await this.ensureInOrbit();
    // Re-check after ensureInOrbit(), not only before it: if the ship was
    // already IN_TRANSIT toward this exact waypoint (a real in-flight
    // navigate left over from before a process restart, which the game keeps
    // flying regardless of what this process remembers), ensureInOrbit()
    // waited out that arrival and refreshed — and the guard above ran before
    // that wait, so without this second check we fire a redundant navigate at
    // the waypoint we just confirmed we are standing on.
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") return;

    const need = this.registry.fuelFor(this.ship.nav.waypointSymbol, waypoint);
    if (this.ship.fuel.capacity > 0) {
      // Pick a mode only from a distance actually measured, but never leave a
      // ship sitting in DRIFT because one could not be. Both halves are
      // load-bearing. An unmeasured distance is Infinity, and feeding that to
      // chooseFlightMode reads as "cannot afford CRUISE" and returns DRIFT
      // every time — a trader spent 7h34m on a 172-unit leg with a nearly full
      // tank that way. But simply leaving the mode alone is also wrong: DRIFT
      // is sticky, so a ship that drifted once goes on crawling every leg
      // after, and since the report below only fired on a change it did so
      // silently. Unmeasurable means fall back to CRUISE and let the real
      // navigate call be the authority on reachability.
      const mode = Number.isFinite(need)
        ? chooseFlightMode(need, this.ship.fuel.current, this.ship.fuel.capacity)
        : this.ship.nav.flightMode === "DRIFT"
          ? "CRUISE"
          : undefined;
      if (mode !== undefined && mode !== this.ship.nav.flightMode) {
        try {
          const patched = await this.api.patchShipNav(this.ship.symbol, mode);
          this.ship = { ...this.ship, nav: patched.nav, fuel: patched.fuel };
          this.onActivity?.("flightmode", `${mode.toLowerCase()} mode${flightModeReason(mode)} (${this.ship.fuel.current}/${this.ship.fuel.capacity} fuel)`, undefined, this.ship.symbol);
        } catch (err) {
          this.log(`flight mode change to ${mode} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Report the mode this leg actually flies in, not merely transitions
      // into: DRIFT turns a minutes-long leg into an hours-long one and used
      // to be reported only through onActivity, which is the dashboard rather
      // than the app log, so a ship that vanished for seven hours left no
      // record of why.
      if (this.ship.nav.flightMode === "DRIFT") {
        this.log(`DRIFT leg to ${waypoint}: needs ${need} at cruise, have ${this.ship.fuel.current}/${this.ship.fuel.capacity}`);
      }
    }

    this.step = { kind: "navigating", to: waypoint };
    try {
      const arrival = await this.api.navigateShip(this.ship.symbol, waypoint);
      this.ship = { ...this.ship, nav: arrival.nav, fuel: arrival.fuel };
      this.onActivity?.("navigate", `→ ${waypoint} (${arrival.fuel.current}/${arrival.fuel.capacity} fuel)`, undefined, this.ship.symbol);
      const wait = new Date(arrival.nav.route.arrival).getTime() - Date.now();
      if (this.schedulerDriven) {
        if (wait > 0) throw new NavigationPending(Date.now() + wait);
        await this.refresh();
      } else {
        if (wait > 0) {
          this.log(`navigating to ${waypoint}, ETA ${Math.round(wait / 1000)}s`);
          await sleep(wait + 1000);
        }
        await this.refresh();
      }
      this.step = IDLE_STEP;
    } catch (err) {
      // A Pending means the ship genuinely is still navigating — leave the
      // step reading "navigating" rather than resetting it to idle, so
      // ship_state keeps reporting the real target across the wait.
      if (err instanceof NavigationPending || err instanceof CooldownPending) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // The live API's actual wording is "...is currently located at the
      // destination...", which the older checks for "already located at the
      // destination" / "already at the destination" do not match — confirmed
      // live, and still wrong in siphoner.ts before this class existed, where
      // a genuine already-there response was reported as a navigation
      // failure. Matching the middle of the phrase is robust to the prefix.
      if (/located at the destination/i.test(msg)) {
        await this.refresh();
        this.step = IDLE_STEP;
        return;
      }
      this.step = IDLE_STEP;
      throw err;
    }
  }

  /**
   * Refuse an action unless the ship is standing where the plan says it is.
   *
   * Rule 5 of docs/control-plane-data-plane.md, at the only boundary that can
   * enforce it: a transaction is irreversible, so the position it assumes has
   * to be the observed one rather than the one the preceding statements
   * intended. A navigate that did not arrive — a `Pending` swallowed, a
   * failure logged and returned, a straight-line procedure resumed after a
   * restart — leaves the ship somewhere else, and the API will happily buy or
   * sell at whatever market it is actually docked at. That is how the trader
   * lost 9,036c per cycle to trades it believed were happening elsewhere.
   *
   * It lives here rather than in each agent because the proxy is the one
   * thing that knows where the ship really is; an agent asserting against its
   * own cached copy would be checking the plan against the plan.
   */
  assertAt(waypoint: string, action: string): void {
    const here = this.ship.nav.waypointSymbol;
    if (here !== waypoint) throw new Error(`refusing to ${action} at ${waypoint}: ship is at ${here}`);
  }

  /**
   * Every market in this system the ship could actually be refuelled at:
   * trait-marked or priced, with a known position. Scoped to one system,
   * because a market a jump away is not somewhere a fuel detour can reach.
   */
  marketEndpointsHere(): { symbol: string }[] {
    return this.registry.marketEndpoints(this.ship.nav.systemSymbol);
  }

  /** Nearest market reachable on the fuel currently aboard, or undefined. */
  nearestReachableMarket(): string | undefined {
    let best: string | undefined;
    let bestNeed = Infinity;
    for (const m of this.marketEndpointsHere()) {
      const need = this.registry.fuelFor(this.ship.nav.waypointSymbol, m.symbol);
      if (need > this.ship.fuel.current) continue;
      if (need < bestNeed) { bestNeed = need; best = m.symbol; }
    }
    return best;
  }

  /** Nearest market to some other waypoint, for budgeting a return leg. */
  nearestMarketTo(waypoint: string): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.registry.marketEndpoints(this.registry.systemOf(waypoint))) {
      const d = this.registry.fuelFor(waypoint, m.symbol);
      if (d < bestDist) { bestDist = d; best = m.symbol; }
    }
    return best;
  }

  /** Out to `target`, then on to the nearest market to it, plus a small margin. */
  fuelNeededRoundTrip(target: string): number {
    const out = this.registry.fuelFor(this.ship.nav.waypointSymbol, target);
    const market = this.nearestMarketTo(target);
    const back = market ? this.registry.fuelFor(target, market) : out;
    return out + back + 5;
  }

  /**
   * Fly this ship's repair goal — the first goal an agent executes *from*
   * rather than stands down on, and step 5 of
   * docs/control-plane-data-plane.md.
   *
   * It lives here, not in one agent class, for the reason this whole file
   * exists: any hull can take damage, so a repair every role can be given but
   * only one role can carry out is worse than no change at all. Putting it in
   * the shared executor is what makes "the controller proposes and never
   * touches the ship" true for traders, scouts and siphoners too.
   *
   * The controller used to suspend the agent and fly the hull itself, which
   * rule 1 forbids and which produced exactly the failure the rule predicts:
   * suspend() resolves only once the agent's in-flight iteration finishes, so
   * the controller regularly took a ship that had just been sent elsewhere,
   * and DAGGER-8's repair "ended at X1-KU72-E49, not X1-KU72-A2". As a goal
   * the ship executes, there is one owner and the race cannot happen.
   *
   * Re-derived from observed position each tick, like a trade: get to the
   * yard, and repair only once standing there.
   */
  async runRepairGoal(intent: ShipIntent, currentIntent: () => ShipIntent | undefined): Promise<boolean> {
    if (intent.goal.kind !== "repair") return false;
    const yard = intent.goal.yard;
    await this.refresh();
    await this.waitCooldown();

    if (this.ship.nav.waypointSymbol !== yard) {
      this.log(`repair: heading to ${yard} (${intent.reason})`);
      await this.navigateTo(yard);
      return true;
    }

    await this.ensureDocked();
    // Re-read the board before spending credits. A repair superseded while the
    // ship was in transit — outranked by a rescue, or the hull recovered — must
    // not still be paid for on arrival. This is what `version` was built for
    // and what nothing read until now.
    if (supersedes(intent, currentIntent())) {
      this.log("repair: superseded in transit, standing by for the new goal");
      return true;
    }

    // Rule 5: repairing is a transaction, so it gets the same precondition
    // every other transaction now has. The re-check above already guards the
    // common case, but ensureDocked() sits between them and this is the
    // statement that spends credits — the yard the fleet is paying is the
    // one the ship is standing at, or nothing happens.
    this.assertAt(yard, "repair");
    try {
      await this.repairHere?.(this.ship.symbol);
    } catch (err) {
      this.log(`repair at ${yard} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  /**
   * Fly an operator hold: get to the waypoint, then sit there.
   *
   * The step-4 counterpart of runRepairGoal(). A hold used to be a private
   * `manualGoal` field on each agent, set by `dispatchTo()` — which also flew
   * the ship inline, from the fleet, breaking rule 1 the same way the repair
   * controller did. That made the operator a second owner beside the intent
   * board: `isManual()` and the board could disagree, and the dashboard read
   * one while the arbiter read the other.
   *
   * Now the operator proposes a `hold` intent like any other controller and
   * the hull flies it. Position is re-derived every tick, so a hold placed on
   * a ship in transit simply completes on arrival rather than needing the
   * operator to wait for it.
   *
   * A hold with no waypoint means "stay where you are" — the arbiter's way of
   * saying there is nothing worth doing — and needs no movement at all.
   */
  async runHoldGoal(intent: ShipIntent, currentIntent: () => ShipIntent | undefined): Promise<boolean> {
    if (intent.goal.kind !== "hold") return false;
    const target = intent.goal.waypoint;
    if (!target) return false;

    await this.refresh();
    if (this.ship.nav.waypointSymbol !== target || this.ship.nav.status === "IN_TRANSIT") {
      // Re-checked before it is acted on, not assumed from when the hold was
      // placed: the same reason supersedes() exists below.
      if (supersedes(intent, currentIntent())) {
        this.log("hold: superseded in transit, standing by for the new goal");
        return true;
      }
      this.log(`hold: heading to ${target} (${intent.reason})`);
      await this.refuelIfNeeded({ reserve: intent.policy.fuelReserve, target });
      await this.navigateTo(target);
      return true;
    }
    // Already parked. Report no work rather than success: a held ship should
    // get the scheduler's idle backoff, not be re-polled as though it were
    // mid-task. This also keeps the rescue controller's own hold — proposed
    // on a stranded ship at its current waypoint — costing nothing, since
    // there is nowhere for it to fly and no fuel to fly with.
    return false;
  }

  // ─── Explore phase ──────────────────────────────────────────────────────────

  /**
   * Fly an explore goal: navigate to the home gate, jump, survey the target
   * system, then tour up to three market waypoints before returning control.
   *
   * All routing data is embedded in the intent goal itself — gate, remoteGate,
   * and the pre-computed list of markets to visit — so the executor reads no
   * fleet state beyond the intent board.
   *
   * Phase is tracked per-ship in explorePhase so the executor can resume on
   * the right step across scheduler ticks without re-doing work already done.
   *
   * done() is called on completion so the fleet can forget the intent.
   */
  async runExploreGoal(
    intent: ShipIntent,
    currentIntent: () => ShipIntent | undefined,
  ): Promise<boolean> {
    if (intent.goal.kind !== "explore") return false;

    const key = this.ship.symbol;
    let phase = this.explorePhase.get(key) ?? ExplorePhase.GATE;

    if (supersedes(intent, currentIntent())) {
      this.explorePhase.delete(key);
      this.exploreMarketIndex.delete(key);
      this.log("explore: superseded, standing by for the new goal");
      this.done?.();
      return false;
    }

    // GATE — navigate to the local jump gate
    if (phase === ExplorePhase.GATE) {
      if (this.ship.nav.waypointSymbol !== intent.goal.gate) {
        this.log(`explore: heading to gate ${intent.goal.gate}`);
        await this.navigateTo(intent.goal.gate);
        return true;
      }
      // At the gate: proceed to the jump
      phase = ExplorePhase.JUMP;
      this.explorePhase.set(key, phase);
    }

    // JUMP — execute the jump, then load the target system so the registry
    // knows the ship is now in the new system before navigating to markets
    if (phase === ExplorePhase.JUMP) {
      await this.refresh();
      await this.waitCooldown();
      this.log(`explore: jumping to ${intent.goal.system} via ${intent.goal.remoteGate}`);
      await this.api.jumpShip(this.ship.symbol, intent.goal.remoteGate);
      // Reload the ship's position so the registry knows it is now in the
      // target system before the next navigation leg is budgeted
      if (this.galaxy) await this.galaxy.loadSystem(intent.goal.system);
      await this.refresh();
      phase = ExplorePhase.SURVEY;
      this.explorePhase.set(key, phase);
    }

    // SURVEY — survey markets in the target system (persisted via the store)
    if (phase === ExplorePhase.SURVEY) {
      await this.waitCooldown();
      if (this.galaxy) {
        this.log(`explore: surveying markets in ${intent.goal.system}`);
        await this.galaxy.surveyMarkets(intent.goal.system, this.store);
      }
      phase = ExplorePhase.MARKET;
      this.explorePhase.set(key, phase);
    }

    // MARKET — visit each pre-computed market in the target system
    if (phase === ExplorePhase.MARKET) {
      const markets = intent.goal.markets;
      let idx = this.exploreMarketIndex.get(key) ?? 0;

      if (idx < markets.length) {
        const market = markets[idx]!;
        if (this.ship.nav.waypointSymbol !== market) {
          this.log(`explore: touring market ${market}`);
          await this.navigateTo(market);
          return true;
        }
        // At the market: record the snapshot and advance
        await this.recordMarket?.(market);
        idx++;
        this.exploreMarketIndex.set(key, idx);
        return true;
      }
      phase = ExplorePhase.DONE;
      this.explorePhase.set(key, phase);
    }

    // DONE — explore complete
    if (phase === ExplorePhase.DONE) {
      this.explorePhase.delete(key);
      this.exploreMarketIndex.delete(key);
      this.log(`explore: ${intent.goal.system} complete`);
      this.done?.();
      return false;
    }

    return true;
  }

  // ─── Tender phase ────────────────────────────────────────────────────────────

  /**
   * Fly a tender goal: buy fuel at a market, deliver it to a stranded ship.
   *
   * All routing data is embedded in the intent goal itself — market waypoint,
   * fuel units, and stranded ship symbol — so the executor reads no fleet state.
   *
   * Phase is tracked per-ship in tenderPhase so the executor can resume on
   * the right step across scheduler ticks.
   *
   * done() is called on completion so the fleet can forget the intent.
   */
  async runTenderGoal(
    intent: ShipIntent,
    currentIntent: () => ShipIntent | undefined,
  ): Promise<boolean> {
    if (intent.goal.kind !== "tender") return false;

    const key = this.ship.symbol;
    let phase = this.tenderPhase.get(key) ?? TenderPhase.BUY;

    if (supersedes(intent, currentIntent())) {
      this.tenderPhase.delete(key);
      this.log("tender: superseded, standing by for the new goal");
      this.done?.();
      return false;
    }

    // BUY — navigate to the fuel market, top off, and buy fuel units
    if (phase === TenderPhase.BUY) {
      if (this.ship.nav.waypointSymbol !== intent.goal.market) {
        await this.ensureInOrbit();
        this.log(`tender: heading to market ${intent.goal.market} to load fuel`);
        await this.navigateTo(intent.goal.market);
        return true;
      }
      // At the market: dock, top off, buy fuel
      await this.ensureDocked();
      if (this.ship.fuel.capacity > 0 && this.ship.fuel.current < this.ship.fuel.capacity) {
        await this.api.refuelShip(this.ship.symbol);
      }
      const held = this.ship.cargo.inventory?.find((i) => i.symbol === "FUEL")?.units ?? 0;
      const toBuy = Math.max(0, intent.goal.fuelUnits - held);
      if (toBuy > 0) {
        await this.api.purchaseCargo(this.ship.symbol, "FUEL", toBuy);
        this.log(`tender: loaded ${toBuy}u FUEL for ${intent.goal.strandedSymbol}`);
      }
      phase = TenderPhase.TRANSIT;
      this.tenderPhase.set(key, phase);
    }

    // TRANSIT — navigate to the stranded ship
    if (phase === TenderPhase.TRANSIT) {
      await this.ensureInOrbit();
      if (this.ship.nav.waypointSymbol !== intent.goal.to) {
        this.log(`tender: en route to ${intent.goal.to} with fuel`);
        await this.navigateTo(intent.goal.to);
        return true;
      }
      phase = TenderPhase.TRANSFER;
      this.tenderPhase.set(key, phase);
    }

    // TRANSFER — align dock states, jettison from the stranded ship if needed,
    // transfer fuel, and refuel the stranded ship
    if (phase === TenderPhase.TRANSFER) {
      const stranded = await this.api.getShip(intent.goal.strandedSymbol);

      // Align dock state: both ships must be docked or both in orbit
      if (stranded.nav.status !== this.ship.nav.status) {
        if (stranded.nav.status === "DOCKED" && this.ship.nav.status === "IN_ORBIT") {
          await this.api.dockShip(this.ship.symbol);
        } else if (stranded.nav.status === "IN_ORBIT" && this.ship.nav.status === "DOCKED") {
          await this.api.orbitShip(this.ship.symbol);
        }
      }

      // Jettison from the stranded ship to make room for fuel if needed
      const freeSpace = stranded.cargo.capacity - stranded.cargo.units;
      if (freeSpace < intent.goal.fuelUnits) {
        const overflow = intent.goal.fuelUnits - freeSpace;
        let dumped = 0;
        for (const item of [...(stranded.cargo.inventory ?? [])]) {
          if (dumped >= overflow) break;
          if (item.symbol === "FUEL") continue;
          const drop = Math.min(overflow - dumped, item.units);
          await this.api.jettisonCargo(intent.goal.strandedSymbol, item.symbol, drop);
          dumped += drop;
        }
        if (dumped > 0) this.log(`tender: jettisoned ${dumped}u from ${intent.goal.strandedSymbol} to make room`);
      }

      // Transfer fuel and refuel the stranded ship
      try {
        await this.api.transferCargo(this.ship.symbol, "FUEL", intent.goal.fuelUnits, intent.goal.strandedSymbol);
        await this.api.refuelShip(intent.goal.strandedSymbol, undefined, true);
        this.log(`tender: transferred ${intent.goal.fuelUnits}u FUEL to ${intent.goal.strandedSymbol}`);
      } catch (err) {
        this.log(`tender transfer failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      phase = TenderPhase.DONE;
      this.tenderPhase.set(key, phase);
    }

    // DONE
    if (phase === TenderPhase.DONE) {
      this.tenderPhase.delete(key);
      this.log(`tender: delivery complete for ${intent.goal.strandedSymbol}`);
      this.done?.();
      return false;
    }

    return true;
  }

  /** Clear phase state for a ship — called when the fleet forgets its intent. */
  forgetPhase(shipSymbol: string): void {
    this.explorePhase.delete(shipSymbol);
    this.exploreMarketIndex.delete(shipSymbol);
    this.tenderPhase.delete(shipSymbol);
  }

  /**
   * Top up if the ship needs it, detouring to a market when it is not at one.
   * Returns false when it genuinely cannot be fuelled — the caller must then
   * hold rather than fly the leg anyway.
   *
   * Merged from three copies that had drifted into different behaviour, not
   * just different comments: one refreshed after refuelling while another
   * patched its cached ship in place, one reported the purchase as activity
   * and the other did not, and one executed a whole inline detour whose tail
   * had become dead code — under the scheduler, navigateTo() ends the tick,
   * so anything written after it never runs and the next tick must re-derive.
   * The re-entrant shape below is the one that survives that correctly.
   */
  async refuelIfNeeded(opts: RefuelOptions = {}): Promise<boolean> {
    if (this.ship.fuel.capacity <= 0) return true;
    const reserve = opts.reserve ?? 0;
    const here = this.ship.nav.waypointSymbol;
    // The trait is the authority, with a recorded snapshot as the fallback: a
    // ship parked on an unpriced fuel station is standing on a pump, and
    // saying otherwise is how one reported itself stranded at 27/300.
    const atMarket = this.registry.isMarket(here) || this.registry.market(here) !== undefined;

    const enough = opts.belowFraction !== undefined
      ? this.ship.fuel.current > this.ship.fuel.capacity * opts.belowFraction
      : this.ship.fuel.current > (opts.target ? this.fuelNeededRoundTrip(opts.target) : this.ship.fuel.capacity * 0.9) + reserve;
    if (enough) return true;

    if (atMarket) {
      await this.ensureDocked();
      this.log(`refueling (${this.ship.fuel.current}/${this.ship.fuel.capacity})`);
      try {
        const res = await this.api.refuelShip(this.ship.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: this.ship.symbol,
          waypointSymbol: this.ship.nav.waypointSymbol,
          type: "REFUEL",
          units: res.fuel.current,
          total: res.transaction.totalPrice,
        });
        this.onActivity?.("refuel", `${this.ship.symbol} refueled to ${res.fuel.current}/${res.fuel.capacity}`, -res.transaction.totalPrice, this.ship.symbol);
        this.ship = { ...this.ship, fuel: res.fuel };
        return true;
      } catch (err) {
        // The MARKETPLACE trait does not promise the market sells FUEL. Fall
        // through to the detour rather than throwing into the caller's tick,
        // which would just trade one error loop for another.
        this.log(`refuel here failed (${err instanceof Error ? err.message : String(err)}); looking for another market`);
      }
    }

    const stop = this.nearestReachableMarket();
    if (!stop || stop === here) {
      this.log(`WARN: cannot refuel (${this.ship.fuel.current}/${this.ship.fuel.capacity}) and no reachable market`);
      return false;
    }
    this.log(`fuel ${this.ship.fuel.current}, detouring to ${stop} to refuel`);
    // Throws NavigationPending under the scheduler, ending the tick; the next
    // one re-enters here and takes the at-market branch. On the blocking path
    // the recursion does the same thing immediately.
    await this.navigateTo(stop);
    return this.refuelIfNeeded(opts);
  }
}

/**
 * Fuel handling, shared. Split out of the class body only to keep the file
 * readable; these are methods on ShipProxy via the declaration merge below.
 */
export interface RefuelOptions {
  /** Keep this much fuel spare beyond the trip itself. */
  reserve?: number;
  /** Where the ship is about to go, so the round trip can be budgeted. */
  target?: string;
  /** Refuel whenever below this fraction of capacity, instead of budgeting a
   *  trip. What the siphoner wants: it never plans a round trip, it just tops
   *  up whenever it is at a pump and low. */
  belowFraction?: number;
}
