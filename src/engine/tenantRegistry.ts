import type pg from "pg";
import { Client, RateLimiter, SpaceTradersAPI } from "../core/client.js";
import { Store } from "../db/store.js";
import { FleetState } from "./state.js";
import { ContractManager } from "./contract.js";
import { FleetManager } from "./fleet.js";
import { ChatAgent } from "./agentChat.js";
import { NarrativeWriter } from "./narrative.js";
import { MarketIntel, type MarketSnapshot } from "./market.js";
import { DiscordRelay } from "./discord.js";
import { Scheduler } from "./scheduler.js";
import { getTenantToken, getTenantLlmConfig, setTenantLlmConfig, getTenantDiscordWebhook, getTenantDiscordEnabled, listAllTenants, needsOnboarding } from "../db/tenants.js";

export interface TenantWorker {
  tenantId: string;
  agentSymbol: string;
  api: SpaceTradersAPI;
  store: Store;
  state: FleetState;
  contracts: ContractManager;
  fleet: FleetManager;
  discord: DiscordRelay;
  /** Greenfield Phase 5: booted per tenant, running, but with nothing ever enqueued yet — see scheduler.ts's class comment. */
  scheduler: Scheduler;
  chat?: ChatAgent;
  /** Always present — it decides internally whether an LLM is available and
   *  falls back to the templated log when one is not. */
  narrative: NarrativeWriter;
}

const STATE_REFRESH_MS = 20_000;
/** Effectively "forever" — same value straders' own CLI defaults to for a
 *  long-running process; run() resolves after this many ticks per ship loop. */
const RUN_FOREVER_TICKS = 1_000_000;

/**
 * Holds one live engine bundle per tenant — `{ api, store, state, fleet,
 * chat? }` — exactly as designed in docs/architecture-plan.md §5. The only
 * change from that doc's original sketch: `store` here is one shared
 * `Store` instance over the shared pool (tenant-scoped per call via
 * `tenantId`, not a separate object per tenant), since that's how
 * `src/db/store.ts` actually ended up shaped — cheaper than a new pool
 * client per tenant, and RLS does the isolation regardless of how many
 * `Store` instances point at the same pool.
 *
 * Lifecycle rule from the architecture doc, restated because it's load-
 * bearing: once booted, a tenant's engine keeps running whether or not
 * their dashboard tab is open. `getOrCreate` starts the coordinator loop
 * (`fleet.run`) and a state-refresh interval in the background and returns
 * immediately after `fleet.init()` — it does not wait for `run()` to
 * finish, because `run()` doesn't finish; it runs for the life of the
 * process. Concurrent calls for the same tenant (e.g. two requests racing
 * right after login) share one in-flight boot instead of double-starting
 * the fleet — `starting` is where that's deduped.
 */
export class TenantRegistry {
  private readonly workers = new Map<string, TenantWorker>();
  private readonly starting = new Map<string, Promise<TenantWorker>>();
  /**
   * One token bucket for every tenant's Client this process ever builds.
   * SpaceTraders enforces its rate limit per IP address, not per agent
   * token — a multi-tenant process serving N tenants from one IP is really N
   * Clients sharing one real ceiling. Each Client self-throttling to 1.5
   * req/s independently (the default when no `sharedLimiter` is given — see
   * client.ts's `ClientOptions` doc comment) only holds that ceiling for a
   * single tenant; with N tenants active it admits up to N * 1.5 req/s from
   * the same IP, which is exactly what produced sustained 429s in production
   * once several tenants had ships running at once. One shared bucket here
   * means the whole process — every tenant combined — actually stays under
   * the real per-IP ceiling instead of each tenant believing it has the full
   * budget to itself.
   */
  // Burst is capped to ceil(rate) so the bucket can't dump a large backlog of
  // requests into a single API-rate window after any idle spell. See the
  // matching comment in src/core/client.ts for why this matters.
  private readonly apiLimiter = new RateLimiter(1.5, Math.ceil(1.5));

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: (tenantId: string, msg: string) => void = (tenantId, msg) =>
      console.log(`[tenant ${tenantId.slice(0, 8)}] ${msg}`),
    /** Injectable so tests can substitute a fake API instead of hitting the real SpaceTraders API. */
    private readonly buildApi: (token: string) => SpaceTradersAPI = (token) =>
      new SpaceTradersAPI(
        new Client({
          token,
          sharedLimiter: this.apiLimiter,
          onRateLimited: (sec, attempt) => this.log("?", `rate limited, backing off ${sec}s (attempt ${attempt})`),
        }),
        token,
      ),
  ) {}

  /** An already-booted worker, if one exists — never triggers a boot. */
  get(tenantId: string): TenantWorker | undefined {
    return this.workers.get(tenantId);
  }

  /**
   * Boot every known tenant's engine now, instead of waiting for that
   * tenant's first authenticated request. Without this, a process restart
   * (a Render redeploy, a crash, host maintenance) leaves every tenant's
   * fleet sitting idle — silently defeating "a tenant's engine keeps
   * running whether or not their dashboard tab is open" for however long it
   * takes someone to hit an authenticated route again. See docs/adr/0009.
   *
   * Boots concurrently rather than one at a time — the shared `apiLimiter`
   * already serializes the real HTTP calls fleet-wide, so there's no
   * separate throttling concern here. One tenant's boot failing (a revoked
   * token, a transient DB error) must never block any other tenant from
   * starting, so this isolates each boot with `Promise.allSettled` rather
   * than propagating the first rejection: `main()` calling this should log
   * and continue, not crash the server, over one bad tenant.
   */
  async bootAll(): Promise<void> {
    const tenants = await listAllTenants(this.pool);
    if (tenants.length === 0) return;
    this.log("?", `eager-booting ${tenants.length} known tenant${tenants.length === 1 ? "" : "s"}`);
    const results = await Promise.allSettled(tenants.map((t) => this.getOrCreate(t.id, t.agentSymbol)));
    const failed = results.filter((r) => r.status === "rejected");
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        this.log(tenants[i]!.id, `eager boot failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
    this.log("?", `eager boot done: ${results.length - failed.length}/${results.length} tenant${results.length === 1 ? "" : "s"} started`);
  }

  /**
   * Set (or clear, by passing undefined) a tenant's co-pilot LLM config and
   * apply it to the live worker immediately — same "no restart needed"
   * contract as DiscordRelay.setWebhook(), but the co-pilot has no
   * lower-level setter to mutate (ChatAgent's constructor is where
   * apiKey/model/baseUrl get wired to the underlying ChatLLM), so this
   * replaces `worker.chat` outright rather than reconfiguring it in place.
   * A worker that hasn't booted yet in this process just picks up the new
   * config the normal way, from getTenantLlmConfig() in getOrCreate() above.
   */
  async setLlmConfig(tenantId: string, config: { provider: string; baseUrl?: string; model: string; apiKey: string } | undefined): Promise<void> {
    await setTenantLlmConfig(this.pool, tenantId, config);
    const worker = this.workers.get(tenantId);
    if (!worker) return;
    worker.narrative = new NarrativeWriter({
      envFallback: false,
      apiKey: config?.apiKey,
      model: config?.model,
      baseUrl: config?.baseUrl,
      onEvent: (e) => this.log(tenantId, `[narrative] ${e.type}: ${e.detail}`),
    });
    worker.chat = config
      ? new ChatAgent({
          state: worker.state,
          store: worker.store,
          fleet: worker.fleet,
          api: worker.api,
          tenantId: worker.tenantId,
          agentSymbol: worker.agentSymbol,
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
          onEvent: (e) => this.log(tenantId, `[copilot] ${e.type}: ${e.detail}`),
        })
      : undefined;
  }

  /** Get a tenant's worker, booting it (once) if this process hasn't seen it yet. */
  async getOrCreate(tenantId: string, agentSymbol: string): Promise<TenantWorker> {
    const existing = this.workers.get(tenantId);
    if (existing) return existing;
    const inFlight = this.starting.get(tenantId);
    if (inFlight) return inFlight;
    const promise = this.boot(tenantId, agentSymbol).finally(() => this.starting.delete(tenantId));
    this.starting.set(tenantId, promise);
    const worker = await promise;
    this.workers.set(tenantId, worker);
    return worker;
  }

  /** Number of tenants currently running in this process. */
  size(): number {
    return this.workers.size;
  }

  /** Stop every booted tenant's coordinator loop (graceful shutdown, and what tests use to let the process exit). */
  stopAll(): void {
    for (const worker of this.workers.values()) {
      worker.fleet.stop();
      worker.scheduler.stop();
    }
  }

  private async boot(tenantId: string, agentSymbol: string): Promise<TenantWorker> {
    const log = (msg: string) => this.log(tenantId, msg);
    const token = await getTenantToken(this.pool, tenantId);
    const api = this.buildApi(token);
    // Boosted for the duration of boot only — see Client.setPriority()'s own
    // comment for why this has to mutate the one shared Client in place
    // rather than handing FleetManager/GalaxyAtlas a separately-prioritized
    // clone. Flipped back to routine priority right after fleet.init()
    // completes, below, before this tenant's steady-state ticking starts —
    // otherwise this boost would leak forever into that ticking and start
    // starving every other tenant instead of just getting this one started
    // faster.
    // Optional-called: a test's injected fake API legitimately has no rate
    // limiter to prioritise, and boot must not die on its absence.
    api.setPriority?.(0);
    const store = new Store(this.pool);
    const state = new FleetState();

    const agent = await api.getMyAgent();
    const systemSymbol = agent.headquarters.slice(0, agent.headquarters.lastIndexOf("-"));
    log(`booting ${agent.symbol} @ ${agent.headquarters}, ${agent.credits} credits, ${agent.shipCount} ships`);

    // No placeholder state.update() here anymore — getOrCreate() doesn't
    // return this worker to any caller until boot() fully resolves (and
    // refreshState() below runs before it does), so nothing could ever have
    // observed an intermediate state between here and there. This used to
    // fetch the home system's waypoints itself via a second, redundant
    // api.getAllSystemWaypoints() call — fleet.init() below makes the exact
    // same call through galaxy.loadSystem() (now cache-aware, see
    // GalaxyAtlas's own comment); waypoints/mappedWaypoints are derived from
    // that afterward instead of fetched twice.

    // Try to serve the first dashboard load from data already in Postgres.
    // Ships refresh market snapshots every time they dock, so the DB is
    // normally up to date. A brand-new tenant has nothing cached yet — this
    // used to fall back to a live scan right here, blocking boot() (and
    // therefore every /api/* route for this tenant, including onboarding's
    // own /api/doctrine call, via resolveTenant) on a live API round-trip
    // per market in the system. Confirmed live: with the shared per-IP rate
    // limiter also serving every other tenant's fleet loop, that scan could
    // take minutes, leaving onboarding stuck on "Loading standing orders…"
    // with nothing to show. backgroundMarketRefresh() below already does
    // this exact same scan, unconditionally, after boot returns — so an
    // empty cache here just proceeds with markets=[] (fleet.init() treats
    // that as "no market intel yet," not an error) and lets that one
    // real scan populate it a few seconds later instead of blocking on it.
    const intel = new MarketIntel(api);
    const markets = await this.loadCachedMarkets(store, systemSymbol);
    log(
      markets.length > 0
        ? `booted from ${markets.length} cached markets in ${systemSymbol}`
        : `no cached markets for ${systemSymbol}; scanning live in the background`,
    );

    // This tenant's own relay, never a shared one — see discord.ts's class
    // doc comment for why straders' module-level getDiscord() singleton
    // can't be reused in a multi-tenant process.
    const discord = new DiscordRelay();
    const webhookUrl = await getTenantDiscordWebhook(this.pool, tenantId);
    if (webhookUrl) discord.setWebhook(webhookUrl);
    discord.setEnabled(await getTenantDiscordEnabled(this.pool, tenantId));

    /** One activity recorder, shared by the fleet and by ContractManager.
     *  Extracted rather than duplicated so a contract delivery reaches the
     *  dashboard feed and Discord by exactly the path every other event
     *  already takes. */
    const recordActivity = (kind: string, detail: string, credits?: number, shipSymbol?: string) => {
      const entry = { timestamp: new Date().toISOString(), shipSymbol: shipSymbol ?? "fleet", kind, detail, credits };
      store.recordActivity(tenantId, entry);
      // Trades (buy/sell) and other activity only ever reach the dashboard's
      // own activity feed via this callback — DiscordRelay.postActivity's
      // sell/buy filter (discord.ts) was otherwise dead code, since ship
      // purchases post to Discord directly from fleet.ts and nothing else did.
      discord.postActivity(entry);
    };

    // Contract deliveries and payouts happened in total silence until these
    // were wired in — see ContractManager.deliverVia()/fulfillCompleted().
    const contracts = new ContractManager(api, store, tenantId, {
      log,
      onActivity: recordActivity,
      recordLedger: (e) => store.recordLedger(tenantId, e as never),
    });
    // Replay the operator's own contract decisions before anything can act on
    // them. These used to live only in memory, so a deploy discarded them and
    // the fleet could auto-accept a contract the operator had just declined.
    await contracts.loadOperatorState();
    // Cutover: created before FleetManager (which needs the instance itself
    // to enqueue tasks onto) and before its own isPaused callback has
    // anything to call — `fleet` is assigned just below, but closures over
    // it don't run until the scheduler's own loop actually polls, by which
    // point it's long since been assigned. Same forward-reference pattern
    // MissionManager's own callbacks into FleetManager already use.
    let fleet!: FleetManager;
    const scheduler = new Scheduler({ isPaused: () => fleet.isPaused(), log });
    fleet = new FleetManager({
      api,
      contracts,
      store,
      tenantId,
      log,
      discord,
      scheduler,
      recordLedger: (e) => store.recordLedger(tenantId, e),
      onActivity: recordActivity,
      minCashReserve: 20_000,
    });
    // The SpaceTraders API occasionally returns transient 500s during the burst
    // of init requests — retry indefinitely (capped backoff) so a boot self-heals
    // when the API recovers instead of leaving a tenant permanently un-started.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fleet.init(markets);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const backoffSec = Math.min(60, attempt * 5);
        log(`fleet init attempt ${attempt} failed (${msg}); retrying in ${backoffSec}s`);
        await new Promise((r) => setTimeout(r, backoffSec * 1000));
      }
    }
    // Boot-critical work is done — see the setPriority(0) call above.
    api.setPriority?.(1);

    // Derived from the galaxy atlas fleet.init() just populated (see this
    // function's own earlier comment) rather than fetched separately.
    const waypoints = fleet.getGalaxy().getSystem(systemSymbol)!.waypoints;
    const mappedWaypoints = waypoints.map((w) => ({
      symbol: w.symbol,
      x: w.x,
      y: w.y,
      type: w.type,
      traits: w.traits.map((t) => t.symbol),
    }));

    // A brand-new tenant hasn't confirmed onboarding yet — stay paused
    // (rescue still runs; see FleetManager.tick()'s own comment) rather than
    // start buying ships and making spending decisions on the grandfathered
    // "everything adopted" default the captain never actually chose. Reads
    // the durable tenants.onboarding_pending column (migration 009), not
    // "does this tenant have any doctrine rows" — a tenant who predates
    // onboarding and never touched Book also has zero rows, but is
    // grandfathered, not pending, and must never be paused by this check.
    if (await needsOnboarding(this.pool, tenantId)) await fleet.setPaused(true, "onboarding not confirmed yet — finish the standing-orders screen to launch");

    // Re-hydrate MissionManager's in-memory active/task state from whatever
    // was persisted — list() only reads the rows, startConstruction() is what
    // actually resumes a mission's runtime state (same as straders' own CLI).
    const activeMissions = (await fleet.getMissions()).filter((m) => m.status === "active");
    for (const m of activeMissions) await fleet.startMission(m.targetWaypoint);

    const llmConfig = await getTenantLlmConfig(this.pool, tenantId);
    const chat = llmConfig
      ? new ChatAgent({
          state,
          store,
          fleet,
          api,
          tenantId,
          agentSymbol,
          apiKey: llmConfig.apiKey,
          model: llmConfig.model ?? undefined,
          baseUrl: llmConfig.baseUrl ?? undefined,
          onEvent: (e) => log(`[copilot] ${e.type}: ${e.detail}`),
        })
      : undefined;
    // The captain's log rides on the same key as the co-pilot. It is the
    // cheaper of the two by a wide margin — one short completion at most
    // every ten minutes — so there is no separate switch for it: if a tenant
    // has given us a model, both features use it.
    const narrative = new NarrativeWriter({
      envFallback: false,
      apiKey: llmConfig?.apiKey,
      model: llmConfig?.model ?? undefined,
      baseUrl: llmConfig?.baseUrl ?? undefined,
      onEvent: (e) => log(`[narrative] ${e.type}: ${e.detail}`),
    });
    log(chat ? "co-pilot enabled" : "co-pilot disabled (no LLM key set)");
    log(narrative.enabled ? `captain's log: ${narrative.model}` : "captain's log: templated (no LLM key set)");

    // The coordinator/ship loops run for the life of the process, not for the
    // life of this call — genuinely fire-and-forget, the one place in this
    // codebase that is, because "keep running whether or not the tab is open"
    // is the whole point of the product. Errors are caught and logged rather
    // than left to crash the process on an unhandled rejection.
    fleet.run(RUN_FOREVER_TICKS).catch((err) => log(`fleet run crashed: ${err instanceof Error ? err.message : String(err)}`));

    // Cutover: this is the scheduler `fleet` above was built with —
    // fleet.run()/tick() enqueues every agent's nextTask() onto it instead
    // of starting the old runLoop()-family blocking loops; this drives
    // execution of whatever's been enqueued, on its own independent poll.
    scheduler.run(RUN_FOREVER_TICKS).catch((err) => log(`scheduler run crashed: ${err instanceof Error ? err.message : String(err)}`));

    // Background refresh: markets/shipyards get stale over time and a brand-new
    // tenant may have started from empty cached data. Refresh them lazily after
    // the dashboard has already been served, exactly as if a ship had docked and
    // recorded fresh snapshots. Errors are caught and logged; never awaited.
    this.backgroundMarketRefresh(log, store, intel, systemSymbol, waypoints, fleet);

    const refreshState = async () => {
      try {
        const freshAgent = await api.getMyAgent();
        const ships = await api.listAllShips();
        const liveContracts = await api.getContracts();
        const systems = fleet.getGalaxy().listSystems().map((s) => ({
          symbol: s.symbol,
          waypoints: s.waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, traits: w.traits.map((t) => t.symbol) })),
          jumpGates: s.jumpGates.map((jg) => jg.symbol),
        }));
        state.update({
          agent: freshAgent,
          ships,
          contracts: liveContracts.filter((c) => !c.fulfilled),
          systemSymbol,
          waypoints: mappedWaypoints,
          systems,
          jumpConnections: fleet.getGalaxy().jumpConnections(),
          totals: await store.ledgerTotals(tenantId),
        });

        // Replay scrubber: one position sample per ship per refresh cycle.
        // Looked up across every known system (not just home), since a ship
        // mid-jump-route sits in a system `mappedWaypoints` doesn't cover.
        const posBySymbol = new Map<string, { x: number; y: number }>();
        for (const s of systems) for (const w of s.waypoints) posBySymbol.set(w.symbol, { x: w.x, y: w.y });
        for (const ship of ships) {
          const pos = posBySymbol.get(ship.nav.waypointSymbol);
          if (!pos) continue;
          await store.recordShipPosition(tenantId, ship.symbol, ship.nav.waypointSymbol, pos.x, pos.y, ship.nav.status);
        }
        await store.pruneShipPositionHistory(tenantId, new Date(Date.now() - 24 * 3600_000).toISOString());
      } catch (err) {
        log(`state refresh error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await refreshState();
    setInterval(refreshState, STATE_REFRESH_MS).unref();

    return { tenantId, agentSymbol, api, store, state, contracts, fleet, discord, scheduler, chat, narrative };
  }

  private async loadCachedMarkets(store: Store, systemSymbol: string): Promise<MarketSnapshot[]> {
    const BOOT_MAX_AGE_MIN = 24 * 60; // accept up to 24h old data at boot
    const rows = await store.freshMarketSnapshots(BOOT_MAX_AGE_MIN);
    const byWaypoint = new Map<string, MarketSnapshot>();
    for (const r of rows) {
      if (r.systemSymbol !== systemSymbol) continue;
      let snapshot = byWaypoint.get(r.waypointSymbol);
      if (!snapshot) {
        snapshot = {
          symbol: r.waypointSymbol,
          systemSymbol: r.systemSymbol,
          tradeGoods: {},
          imports: [],
          exports: [],
          exchange: [],
          fetchedAt: r.timestamp,
        };
        byWaypoint.set(r.waypointSymbol, snapshot);
      }
      snapshot.tradeGoods[r.goodSymbol] = {
        symbol: r.goodSymbol as any,
        type: r.type as any,
        supply: r.supply as any,
        purchasePrice: r.purchasePrice,
        sellPrice: r.sellPrice,
        tradeVolume: r.tradeVolume,
      };
    }
    return [...byWaypoint.values()];
  }

  private async recordMarkets(store: Store, markets: MarketSnapshot[]): Promise<void> {
    // One bulk call instead of one store.recordMarket() per good — a full
    // system scan is 100-150+ goods across every market, which at one pool
    // checkout each was confirmed in production to starve the connection
    // pool (max 10) right when the dashboard's own request burst also
    // wants connections. See Store.recordMarkets()'s own comment.
    const rows = markets.flatMap((m) =>
      Object.values(m.tradeGoods).map((g) => ({
        systemSymbol: m.systemSymbol,
        waypointSymbol: m.symbol,
        goodSymbol: g.symbol,
        type: g.type,
        supply: g.supply,
        purchasePrice: g.purchasePrice,
        sellPrice: g.sellPrice,
        tradeVolume: g.tradeVolume,
      })),
    );
    await store.recordMarkets(rows);
  }

  private backgroundMarketRefresh(
    log: (msg: string) => void,
    store: Store,
    intel: MarketIntel,
    systemSymbol: string,
    waypoints: Awaited<ReturnType<SpaceTradersAPI["getAllSystemWaypoints"]>>,
    fleet: FleetManager,
  ): void {
    (async () => {
      try {
        log(`background refresh: live-scanning markets in ${systemSymbol}`);
        const fresh = await intel.getSystemMarkets(systemSymbol, waypoints);
        await this.recordMarkets(store, fresh);
        log(`background refresh: recorded ${fresh.length} markets`);
        log(`background refresh: live-scanning shipyards in ${systemSymbol}`);
        await fleet.getGalaxy().surveyShipyards(systemSymbol, store);
        log(`background refresh: shipyards done`);
      } catch (err) {
        log(`background refresh error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }
}
