/**
 * Recovers the fleet after a SpaceTraders weekly universe reset with nobody at
 * the keyboard: notices the reset, registers a fresh agent for each tenant,
 * swaps the new token in, clears the dead universe's cached data, and boots the
 * engine. Phase 1 stops there — the new game starts with whatever the engine's
 * defaults do with one fresh ship; defining a starting layout is phase 2.
 *
 * Trigger: the unauthenticated `GET /v2/` status endpoint's `resetDate`
 * differing from the last one this watcher finished handling (stored in
 * `galaxy_crawl_state` under `reset_watcher`). Written level-triggered, not
 * edge-triggered: every tick re-derives what is left to do from observed state
 * (is this tenant's token dead? is its worker booted?), so a failure at any
 * step — API still warming up after the reset, registration refused, boot
 * error — is simply retried on the next tick, and a watcher restart mid-recovery
 * picks up where it left off. The handled date is only written once every
 * tenant has a live token and a booted worker.
 *
 * Safety:
 *  - First run ever records the current resetDate as the baseline and does
 *    nothing — deploying this must not itself trigger a wipe.
 *  - Nothing is wiped unless the tenant's token is positively confirmed dead
 *    (a 401 from the game). A network blip or 5xx is "unknown": the tick aborts.
 *  - Needs `ST_ACCOUNT_TOKEN`. Without it the watcher still detects and reports
 *    the reset (state `needs_account_token`) but changes nothing.
 *  - `AUTO_RESET_RECOVERY=off` disables acting entirely.
 */

export interface ServerStatus {
  resetDate: string;
  nextReset?: string;
}

export type TokenProbe = "alive" | "dead" | "unknown";

export interface WatchedTenant {
  id: string;
  agentSymbol: string;
}

/** Everything the watcher touches, injectable so the recovery logic is unit-testable without a DB or the game. */
export interface ResetWatcherPorts {
  fetchStatus(): Promise<ServerStatus>;
  getSeenResetDate(): Promise<string | undefined>;
  setSeenResetDate(resetDate: string): Promise<void>;
  listTenants(): Promise<WatchedTenant[]>;
  /** Live-verify a tenant's stored token against the game. */
  probeTenant(tenant: WatchedTenant): Promise<TokenProbe>;
  isBooted(tenantId: string): boolean;
  stopWorker(tenantId: string): void;
  wipeTenantGameData(tenantId: string): Promise<void>;
  truncateSharedGalaxy(): Promise<void>;
  resetCrawler(): void;
  /** Register a fresh agent and store its token on that tenant's row. Returns the tenant id now holding the new token. */
  registerAndStore(symbol: string): Promise<{ tenantId: string; agentSymbol: string }>;
  boot(tenantId: string, agentSymbol: string): Promise<void>;
}

export type WatcherState =
  | "disabled"
  | "idle"
  | "recovering"
  | "needs_account_token"
  | "recovered"
  | "error";

export interface WatcherStatus {
  state: WatcherState;
  checkedAt?: string;
  apiResetDate?: string;
  nextReset?: string;
  handledResetDate?: string;
  lastError?: string;
  /** Per-tenant progress of the current/last recovery. */
  tenants: Record<string, string>;
}

export interface ResetWatcherOptions {
  accountTokenConfigured: boolean;
  enabled?: boolean;
  log?: (msg: string) => void;
  now?: () => Date;
}

export class ResetWatcher {
  private readonly log: (msg: string) => void;
  private readonly now: () => Date;
  private readonly enabled: boolean;
  private readonly accountTokenConfigured: boolean;
  private cleanedFor: string | undefined;
  private warnedFor: string | undefined;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private current: WatcherStatus = { state: "idle", tenants: {} };

  constructor(private readonly ports: ResetWatcherPorts, opts: ResetWatcherOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
    this.enabled = opts.enabled ?? true;
    this.accountTokenConfigured = opts.accountTokenConfigured;
    if (!this.enabled) this.current = { state: "disabled", tenants: {} };
  }

  status(): WatcherStatus {
    return { ...this.current, tenants: { ...this.current.tenants } };
  }

  start(pollMs = 60_000): void {
    if (this.timer) return;
    const run = () => this.tick().catch((err) => this.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`));
    void run();
    this.timer = setInterval(run, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Safe to call repeatedly; overlapping calls are dropped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    let status: ServerStatus;
    try {
      status = await this.ports.fetchStatus();
    } catch (err) {
      // The status endpoint itself can flap right around a reset; just try again.
      this.current.lastError = `status fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    this.current.checkedAt = this.now().toISOString();
    this.current.apiResetDate = status.resetDate;
    this.current.nextReset = status.nextReset;

    const seen = await this.ports.getSeenResetDate();
    this.current.handledResetDate = seen;

    let changed = seen !== undefined && seen !== status.resetDate;
    if (seen === undefined) {
      // First run ever. Baseline unless tokens are already dead (the watcher
      // was deployed after a reset it never saw) — then treat it as a reset.
      const tenants = await this.ports.listTenants();
      const probes = await Promise.all(tenants.map((t) => this.ports.probeTenant(t)));
      if (probes.includes("unknown")) return;
      if (!probes.includes("dead")) {
        await this.ports.setSeenResetDate(status.resetDate);
        this.current.handledResetDate = status.resetDate;
        this.log(`baseline resetDate ${status.resetDate} recorded`);
        return;
      }
      changed = true;
    }
    if (!changed) return;
    if (!this.enabled) {
      this.current.state = "disabled";
      return;
    }
    if (!this.accountTokenConfigured) {
      this.current.state = "needs_account_token";
      if (this.warnedFor !== status.resetDate) {
        this.warnedFor = status.resetDate;
        this.log(`server reset detected (resetDate ${seen ?? "?"} -> ${status.resetDate}) but ST_ACCOUNT_TOKEN is not set — cannot auto-register; use the admin page`);
      }
      return;
    }
    await this.recover(status);
  }

  private async recover(status: ServerStatus): Promise<void> {
    this.current.state = "recovering";
    this.log(`server reset detected (resetDate ${this.current.handledResetDate ?? "?"} -> ${status.resetDate}); recovering`);

    const tenants = await this.ports.listTenants();
    const probes = new Map<string, TokenProbe>();
    for (const t of tenants) probes.set(t.id, await this.ports.probeTenant(t));
    if ([...probes.values()].includes("unknown")) {
      this.log("could not confirm token state for every tenant yet; will retry");
      return;
    }
    const dead = tenants.filter((t) => probes.get(t.id) === "dead");

    // Clear the dead universe first, once per reset: the shared tables lie, and
    // a tenant's old ship/ledger rows would otherwise be read by the new fleet.
    if (dead.length > 0 && this.cleanedFor !== status.resetDate) {
      for (const t of dead) {
        this.ports.stopWorker(t.id);
        await this.ports.wipeTenantGameData(t.id);
        this.current.tenants[t.agentSymbol] = "cleared";
      }
      await this.ports.truncateSharedGalaxy();
      this.ports.resetCrawler();
      this.cleanedFor = status.resetDate;
      this.log(`cleared stale data for ${dead.length} tenant(s) and shared galaxy tables`);
    }

    let allDone = true;
    for (const t of tenants) {
      let tenantId = t.id;
      let symbol = t.agentSymbol;
      if (probes.get(t.id) === "dead") {
        try {
          const reg = await this.ports.registerAndStore(t.agentSymbol);
          tenantId = reg.tenantId;
          symbol = reg.agentSymbol;
          this.current.tenants[t.agentSymbol] = "registered";
          this.log(`registered ${symbol} in the new universe`);
        } catch (err) {
          allDone = false;
          const msg = err instanceof Error ? err.message : String(err);
          this.current.tenants[t.agentSymbol] = `register failed: ${msg}`;
          this.current.lastError = `register ${t.agentSymbol}: ${msg}`;
          this.log(`register ${t.agentSymbol} failed (will retry): ${msg}`);
          continue;
        }
      }
      if (!this.ports.isBooted(tenantId)) {
        try {
          await this.ports.boot(tenantId, symbol);
          this.current.tenants[t.agentSymbol] = "booted";
          this.log(`booted ${symbol}`);
        } catch (err) {
          allDone = false;
          const msg = err instanceof Error ? err.message : String(err);
          this.current.tenants[t.agentSymbol] = `boot failed: ${msg}`;
          this.current.lastError = `boot ${t.agentSymbol}: ${msg}`;
          this.log(`boot ${symbol} failed (will retry): ${msg}`);
        }
      } else if (this.current.tenants[t.agentSymbol] === undefined) {
        this.current.tenants[t.agentSymbol] = "booted";
      }
    }

    if (!allDone) {
      this.current.state = "error";
      return;
    }
    await this.ports.setSeenResetDate(status.resetDate);
    this.current.handledResetDate = status.resetDate;
    this.current.state = "recovered";
    this.current.lastError = undefined;
    this.log(`recovery complete for resetDate ${status.resetDate}`);
  }
}

let active: ResetWatcher | undefined;
export function setActiveResetWatcher(w: ResetWatcher): void {
  active = w;
}
export function resetWatcherStatus(): WatcherStatus | undefined {
  return active?.status();
}
