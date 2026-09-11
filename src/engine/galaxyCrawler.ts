import type { SpaceTradersAPI } from "../core/client.js";
import type { Store } from "../db/store.js";

/**
 * Crawls the *public* galaxy-wide reference data — every system's
 * coordinates/type (GET /systems, paginated) and the full faction roster
 * (GET /factions) — into the shared galaxy_systems/galaxy_factions tables
 * (migrations/011_galaxy_topology.sql, 015_galaxy_crawl.sql).
 *
 * This is deliberately independent of any one tenant's own exploration:
 * system coordinates/types and faction rosters are public, static-for-the-
 * reset data any valid token can read, unlike a waypoint's charted traits
 * or live market prices, which genuinely require a ship's physical
 * presence. Confirmed against the live API docs; the same public-endpoint
 * approach is how third-party community cartography tools do this too.
 *
 * Runs against whichever tenant's API client happens to be booted
 * (TenantRegistry.anyBootedApi()) — it draws from the same shared,
 * process-wide rate limiter every tenant's own ticking already competes
 * for, so this ticks slowly and deliberately (one page per call) rather
 * than racing to finish; a galaxy of tens of thousands of systems is a
 * multi-hour-to-multi-day background job either way, same order of
 * magnitude as the third-party tool's "usually mapped by day 2-3."
 *
 * Does NOT yet crawl per-system waypoints/jump-gate connections galaxy-
 * wide — that's a much larger pass (one or more extra calls per system
 * rather than one call per page of 20) layered on top of this once the
 * systems-list crawl itself is proven out live. Until then, jump-gate data
 * keeps coming in only the existing way: reactively, whenever some
 * tenant's own GalaxyAtlas.loadSystem()/scanJumpGates() actually visits a
 * system.
 */
export class GalaxyCrawler {
  private readonly getApi: () => SpaceTradersAPI | undefined;
  private readonly store: Store;
  private readonly log: (msg: string) => void;
  private factionsDone = false;
  private systemsDone = false;

  /**
   * Takes a getter rather than a bound API instance: which tenant happens
   * to be booted can change between ticks (a restart, a tenant not yet
   * boot-complete), and re-resolving it fresh each tick — rather than
   * capturing one tenant's client once — is what lets this start crawling
   * the moment *any* tenant is up, without caring which.
   */
  constructor(getApi: () => SpaceTradersAPI | undefined, store: Store, log: (msg: string) => void = () => {}) {
    this.getApi = getApi;
    this.store = store;
    this.log = log;
  }

  /** One unit of crawl work per call — cheap to call on a slow interval
   *  (see cli/index.ts) without the caller needing to know which phase
   *  the crawl is in. A no-op once both phases have finished, or while no
   *  tenant is booted yet. */
  async tick(): Promise<void> {
    const api = this.getApi();
    if (!api) return;
    if (!this.factionsDone) {
      await this.crawlFactions(api);
      return;
    }
    if (!this.systemsDone) {
      await this.crawlSystemsPage(api);
    }
  }

  /** Full faction roster, one shot — small (a couple dozen entries), so no
   *  resumable cursor needed the way the systems crawl has one. */
  private async crawlFactions(api: SpaceTradersAPI): Promise<void> {
    try {
      const out: { symbol: string; name: string; headquarters?: string; isRecruiting?: boolean }[] = [];
      let page = 1;
      for (;;) {
        const batch = await api.getFactions(20, page);
        for (const f of batch) out.push({ symbol: f.symbol, name: f.name, headquarters: f.headquarters, isRecruiting: f.isRecruiting });
        if (batch.length < 20) break;
        page += 1;
      }
      await this.store.setGalaxyFactions(out);
      this.log(`galaxy crawl: recorded ${out.length} factions`);
    } catch (err) {
      this.log(`galaxy crawl: faction pass failed, will retry next tick: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.factionsDone = true;
  }

  /** One page of the galaxy-wide systems list, resuming from wherever the
   *  last call (this process or an earlier one) left off. */
  private async crawlSystemsPage(api: SpaceTradersAPI): Promise<void> {
    const state = (await this.store.getCrawlState<{ page: number }>("galaxy_systems_crawl")) ?? { page: 1 };
    try {
      const batch = await api.getSystems(20, state.page);
      for (const sys of batch) {
        await this.store.setGalaxySystemMeta(sys.symbol, sys.sectorSymbol, sys.type, sys.x, sys.y);
      }
      if (batch.length < 20) {
        this.systemsDone = true;
        this.log(`galaxy crawl: systems pass complete at page ${state.page} (${await this.store.countGalaxySystems()} systems total)`);
        return;
      }
      await this.store.setCrawlState("galaxy_systems_crawl", { page: state.page + 1 });
    } catch (err) {
      this.log(`galaxy crawl: systems page ${state.page} failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
