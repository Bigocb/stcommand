import type { ContractManager } from "../engine/contract.js";
import { contractPipeline, type Pipeline } from "../engine/contractPipeline.js";
import type { Store } from "../db/store.js";

/**
 * The open contracts and what they are worth, assembled from the live contract list, the ledger's per-contract sums, ships'
 * cargo and market prices (all the I/O; the arithmetic is in engine/contractPipeline.ts).
 */
export async function contractsOverview(w: {
  contracts: ContractManager;
  store: Store;
  tenantId: string;
  ships: { cargo?: { inventory?: { symbol: string; units: number }[] } }[];
}, nowMs: number = Date.now()): Promise<Pipeline> {
  const active = await w.contracts.listActive();
  const open = active.filter((c) => c.accepted && !c.fulfilled);
  const goods = new Set(open.flatMap((c) => (c.terms.deliver ?? []).map((d) => d.tradeSymbol)));
  const prices = new Map<string, number | undefined>();
  await Promise.all([...goods].map(async (g) => { prices.set(g, await w.contracts.cheapestPriceFor(g)); }));
  const held = new Map<string, number>();
  for (const s of w.ships) for (const i of s.cargo?.inventory ?? []) held.set(i.symbol, (held.get(i.symbol) ?? 0) + i.units);
  const ledger = new Map((await w.store.contractLedger(w.tenantId)).map((r) => [r.contractId, r]));
  return contractPipeline(
    open.map((c) => ({
      id: c.id, type: c.type, factionSymbol: c.factionSymbol, accepted: c.accepted, fulfilled: c.fulfilled, abandoned: w.contracts.isAbandoned(c.id),
      deadline: c.terms.deadline, onAccepted: c.terms.payment.onAccepted, onFulfilled: c.terms.payment.onFulfilled,
      deliver: (c.terms.deliver ?? []).map((d) => ({ tradeSymbol: d.tradeSymbol, destinationSymbol: d.destinationSymbol, unitsRequired: d.unitsRequired, unitsFulfilled: d.unitsFulfilled })),
    })),
    { nowMs, cheapestPrice: (g) => prices.get(g), heldUnits: (g) => held.get(g) ?? 0, ledger: (id) => ledger.get(id) },
  );
}
