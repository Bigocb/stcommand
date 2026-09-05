import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { Registry } from "./registry.js";
import { type AgentStep, IDLE_STEP, NavigationPending, CooldownPending } from "./agentStep.js";
import { chooseFlightMode, flightModeReason } from "./flightMode.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ShipProxyOptions {
  api: SpaceTradersAPI;
  registry: Registry;
  log?: (msg: string) => void;
  onActivity?: (kind: string, detail: string, credits?: number, shipSymbol?: string) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
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
export class ShipProxy {
  private ship: Ship;
  private readonly api: SpaceTradersAPI;
  private registry: Registry;
  private readonly log: (msg: string) => void;
  private readonly onActivity?: ShipProxyOptions["onActivity"];
  private readonly recordMarket?: ShipProxyOptions["recordMarket"];
  private step: AgentStep = IDLE_STEP;

  /**
   * True only for the duration of a scheduler `Task.run()` call. While set,
   * anything that would wait — a transit, a cooldown, a short retry backoff —
   * throws a `Pending` carrying the real resume time instead of sleeping, so
   * one ship's wait never occupies the sequential task runner. A manual
   * `dispatchTo()` leaves it false and keeps blocking exactly as before.
   */
  schedulerDriven = false;

  constructor(ship: Ship, opts: ShipProxyOptions) {
    this.ship = ship;
    this.api = opts.api;
    this.registry = opts.registry;
    this.log = opts.log ?? (() => {});
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
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
}
