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

/**
 * Every good that goes into making any of `roots`, however many steps back:
 * the roots' inputs, those inputs' inputs, down to the raw ores. `map` is
 * exportToImportMap as the live API returns it: each KEY is an exported good
 * and its values are what that good's market IMPORTS to make it
 * (FAB_MATS -> ["IRON", "QUARTZ_SAND"], ADVANCED_CIRCUITRY -> ["ELECTRONICS",
 * "MICROPROCESSORS"], IRON -> ["IRON_ORE"]). The roots themselves are not
 * included unless something in the chain also needs one.
 *
 * EXPLOSIVES is skipped: every raw-ore extraction market "imports" it (IRON_ORE ->
 * ["EXPLOSIVES"], QUARTZ_SAND -> ["EXPLOSIVES"]), which would drag the whole
 * explosives chain into every gate's chain without being a real input to the gate.
 */
export function transitiveInputs(roots: Iterable<string>, map: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const g = stack.pop()!;
    for (const input of map[g] ?? []) {
      if (input === "EXPLOSIVES" || out.has(input)) continue;
      out.add(input);
      stack.push(input);
    }
  }
  return out;
}

/**
 * For each chain good, the markets that buy it to make another link of the same chain: a market that EXPORTS one of
 * `chainOutputs` (the gate materials plus their transitive inputs) is a sink for every input `map` lists for that
 * export. Delivering a protected good to one of these feeds the gate's chain instead of draining it, so the chain guard
 * lets those routes through. Confirmed live 2026-10-07 (THEO): MICROPROCESSORS A3 -> D44 (+1,487) and ELECTRONICS
 * F53 -> D44 (+1,383) were dropped as protected while D44 is the ADVANCED_CIRCUITRY producer itself, and the
 * dispatcher had six traders on legs worth +40 to +2,700 a trip.
 */
export function chainSinks(
  chainOutputs: Iterable<string>,
  map: Record<string, string[]>,
  rows: readonly { waypointSymbol: string; goodSymbol: string; type: string }[],
): Map<string, Set<string>> {
  const outputs = new Set(chainOutputs);
  const sinks = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.type !== "EXPORT" || !outputs.has(r.goodSymbol)) continue;
    for (const input of map[r.goodSymbol] ?? []) {
      if (input === "EXPLOSIVES") continue;
      let s = sinks.get(input);
      if (!s) sinks.set(input, (s = new Set()));
      s.add(r.waypointSymbol);
    }
  }
  return sinks;
}

/** Test-only: the module cache is process-wide by design, so tests need a way to reset it between runs. */
export function resetSupplyChainCacheForTests(): void {
  cached = undefined;
  fetchedAt = 0;
}
