import type pg from "pg";
import { Client, SpaceTradersAPI } from "../core/client.js";
import { Store } from "../db/store.js";
import { FleetState } from "./state.js";
import { ContractManager } from "./contract.js";
import { FleetManager } from "./fleet.js";
import { ChatAgent } from "./agentChat.js";
import { MarketIntel } from "./market.js";
import { getTenantToken, getTenantLlmConfig } from "../db/tenants.js";

export interface TenantWorker {
  tenantId: string;
  agentSymbol: string;
  api: SpaceTradersAPI;
  store: Store;
  state: FleetState;
  contracts: ContractManager;
  fleet: FleetManager;
  chat?: ChatAgent;
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

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: (tenantId: string, msg: string) => void = (tenantId, msg) =>
      console.log(`[tenant ${tenantId.slice(0, 8)}] ${msg}`),
    /** Injectable so tests can substitute a fake API instead of hitting the real SpaceTraders API. */
    private readonly buildApi: (token: string) => SpaceTradersAPI = (token) =>
      new SpaceTradersAPI(
        new Client({ token, onRateLimited: (sec, attempt) => this.log("?", `rate limited, backing off ${sec}s (attempt ${attempt})`) }),
        token,
      ),
  ) {}

  /** An already-booted worker, if one exists — never triggers a boot. */
  get(tenantId: string): TenantWorker | undefined {
    return this.workers.get(tenantId);
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
    for (const worker of this.workers.values()) worker.fleet.stop();
  }

  private async boot(tenantId: string, agentSymbol: string): Promise<TenantWorker> {
    const log = (msg: string) => this.log(tenantId, msg);
    const token = await getTenantToken(this.pool, tenantId);
    const api = this.buildApi(token);
    const store = new Store(this.pool);
    const state = new FleetState();

    const agent = await api.getMyAgent();
    const systemSymbol = agent.headquarters.slice(0, agent.headquarters.lastIndexOf("-"));
    log(`booting ${agent.symbol} @ ${agent.headquarters}, ${agent.credits} credits, ${agent.shipCount} ships`);

    const waypoints = await api.getAllSystemWaypoints(systemSymbol);
    const mappedWaypoints = waypoints.map((w) => ({
      symbol: w.symbol,
      x: w.x,
      y: w.y,
      type: w.type,
      traits: w.traits.map((t) => t.symbol),
    }));
    state.update({
      agent,
      ships: [],
      contracts: [],
      systemSymbol,
      waypoints: mappedWaypoints,
      systems: [{ symbol: systemSymbol, waypoints: mappedWaypoints, jumpGates: waypoints.filter((w) => w.type === "JUMP_GATE").map((w) => w.symbol) }],
      jumpConnections: [],
      totals: await store.ledgerTotals(tenantId),
    });

    log(`discovering markets in ${systemSymbol} (${waypoints.length} waypoints)...`);
    const intel = new MarketIntel(api);
    const markets = await intel.getSystemMarkets(systemSymbol);
    for (const m of markets) {
      for (const g of Object.values(m.tradeGoods)) {
        await store.recordMarket({
          systemSymbol: m.systemSymbol,
          waypointSymbol: m.symbol,
          goodSymbol: g.symbol,
          type: g.type,
          supply: g.supply,
          purchasePrice: g.purchasePrice,
          sellPrice: g.sellPrice,
          tradeVolume: g.tradeVolume,
        });
      }
    }
    log(`found ${markets.length} markets`);

    const contracts = new ContractManager(api);
    const fleet = new FleetManager({
      api,
      contracts,
      store,
      tenantId,
      log,
      recordLedger: (e) => store.recordLedger(tenantId, e),
      onActivity: (kind, detail, credits) =>
        store.recordActivity(tenantId, { timestamp: new Date().toISOString(), shipSymbol: "fleet", kind, detail, credits }),
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
    log(chat ? "co-pilot enabled" : "co-pilot disabled (no LLM key set)");

    // The coordinator/ship loops run for the life of the process, not for the
    // life of this call — genuinely fire-and-forget, the one place in this
    // codebase that is, because "keep running whether or not the tab is open"
    // is the whole point of the product. Errors are caught and logged rather
    // than left to crash the process on an unhandled rejection.
    fleet.run(RUN_FOREVER_TICKS).catch((err) => log(`fleet run crashed: ${err instanceof Error ? err.message : String(err)}`));

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
      } catch (err) {
        log(`state refresh error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await refreshState();
    setInterval(refreshState, STATE_REFRESH_MS).unref();

    return { tenantId, agentSymbol, api, store, state, contracts, fleet, chat };
  }
}
