import type { SpaceTradersAPI } from "../core/client.js";

/**
 * `GET /market/supply-chain` — which export goods feed which imports,
 * effectively static game-design data (doesn't change tick to tick, only
 * possibly between game updates). Global and tenant-agnostic: every agent
 * in the same server reset sees the identical production graph, so this is
 * one process-wide in-memory cache, not per-tenant state — same reasoning
 * as the "shared galaxy tables" in store.ts, simpler here since there's
 * nothing worth persisting (re-fetching once per process lifetime is
 * cheap, and the data isn't reset-scoped the way markets/shipyards are).
 */

export interface SupplyChain {
  exportToImportMap: Record<string, string[]>;
  /** Every good symbol that appears anywhere in the graph, either as a raw
   *  export or as something an export feeds into — the practical question
   *  callers actually have ("does this good exist in the production
   *  economy at all") collapses to one Set lookup instead of walking the
   *  map twice. */
  knownGoods: Set<string>;
}

let cached: SupplyChain | undefined;
let fetchedAt = 0;
const TTL_MS = 24 * 60 * 60 * 1000;

export async function getSupplyChain(api: SpaceTradersAPI): Promise<SupplyChain> {
  if (cached && Date.now() - fetchedAt < TTL_MS) return cached;
  const res = await api.getSupplyChain();
  const knownGoods = new Set<string>();
  for (const [exportGood, imports] of Object.entries(res.exportToImportMap)) {
    knownGoods.add(exportGood);
    for (const g of imports) knownGoods.add(g);
  }
  cached = { exportToImportMap: res.exportToImportMap, knownGoods };
  fetchedAt = Date.now();
  return cached;
}

/** Test-only: the module cache is process-wide by design, so tests need a way to reset it between runs. */
export function resetSupplyChainCacheForTests(): void {
  cached = undefined;
  fetchedAt = 0;
}
