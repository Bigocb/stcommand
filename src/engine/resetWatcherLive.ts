import type pg from "pg";
import { API_BASE, APIError, Client } from "../core/client.js";
import { SpaceTradersAPI } from "../core/client.js";
import { registerAgent } from "../core/auth.js";
import { Store } from "../db/store.js";
import { findOrCreateTenant, getTenantToken, listAllTenants } from "../db/tenants.js";
import type { TenantRegistry } from "./tenantRegistry.js";
import type { GalaxyCrawler } from "./galaxyCrawler.js";
import { ResetWatcher, setActiveResetWatcher, type ResetWatcherPorts, type TokenProbe } from "./resetWatcher.js";

const CRAWL_KEY = "reset_watcher";

/** Wires the ResetWatcher to the real game, database and tenant registry. */
export function createResetWatcher(
  pool: pg.Pool,
  registry: TenantRegistry,
  crawler: GalaxyCrawler,
  log: (msg: string) => void,
): ResetWatcher {
  const store = new Store(pool);
  const faction = process.env.RESET_FACTION?.trim() || "COSMIC";

  const ports: ResetWatcherPorts = {
    async fetchStatus() {
      const res = await fetch(`${API_BASE}/`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { resetDate?: string; serverResets?: { next?: string } };
      if (!json.resetDate) throw new Error("no resetDate in status response");
      return { resetDate: json.resetDate, nextReset: json.serverResets?.next };
    },
    async getSeenResetDate() {
      return (await store.getCrawlState<{ resetDate: string }>(CRAWL_KEY))?.resetDate;
    },
    async setSeenResetDate(resetDate) {
      await store.setCrawlState(CRAWL_KEY, { resetDate, handledAt: new Date().toISOString() });
    },
    listTenants: () => listAllTenants(pool),
    async probeTenant(t): Promise<TokenProbe> {
      try {
        const token = await getTenantToken(pool, t.id);
        // A fresh Client, not the worker's: its latched dead-token state must not
        // outlive the registration, and this must work for an unbooted tenant.
        await new SpaceTradersAPI(new Client({ token, maxRetries: 0 }), token).getMyAgent();
        return "alive";
      } catch (err) {
        return err instanceof APIError && err.status === 401 ? "dead" : "unknown";
      }
    },
    isBooted: (id) => registry.isBooted(id),
    stopWorker: (id) => registry.stopOne(id),
    wipeTenantGameData: (id) => store.wipeTenantGameData(id),
    truncateSharedGalaxy: () => store.truncateSharedGalaxyTables(),
    resetCrawler: () => crawler.resetCrawlState(),
    async registerAndStore(symbol) {
      const reg = await registerAgent(symbol, faction);
      // Same agent_symbol => same tenant row, so its MCP key and doctrine survive.
      // This write is the only copy of the new token: do it before anything else.
      const tenant = await findOrCreateTenant(pool, reg.agentSymbol, reg.token);
      return { tenantId: tenant.id, agentSymbol: tenant.agentSymbol };
    },
    async boot(tenantId, agentSymbol) {
      await registry.getOrCreate(tenantId, agentSymbol);
    },
  };

  const watcher = new ResetWatcher(ports, {
    accountTokenConfigured: Boolean(process.env.ST_ACCOUNT_TOKEN),
    enabled: (process.env.AUTO_RESET_RECOVERY ?? "on").toLowerCase() !== "off",
    log: (m) => log(`[reset-watcher] ${m}`),
  });
  setActiveResetWatcher(watcher);
  return watcher;
}
