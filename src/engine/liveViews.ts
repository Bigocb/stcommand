/**
 * The payloads behind the slower screens' sections, shared by their GET endpoints and the live feed, so both send the
 * same thing: contracts, the programme (contracts, missions, feeds, feed chains, the gate's chain health), keepers,
 * and Tower's attention list.
 */
import type { ContractManager } from "./contract.js";
import type { FleetManager } from "./fleet.js";

export async function contractsView(contracts: ContractManager) {
  const list = await contracts.listActive();
  return list.map((c) => ({
    id: c.id,
    factionSymbol: c.factionSymbol,
    type: c.type,
    accepted: c.accepted,
    fulfilled: c.fulfilled,
    deadlineToAccept: c.deadlineToAccept ?? c.expiration,
    deadline: c.terms.deadline,
    onAccepted: c.terms.payment.onAccepted,
    onFulfilled: c.terms.payment.onFulfilled,
    deliver: (c.terms.deliver ?? []).map((d) => ({
      tradeSymbol: d.tradeSymbol,
      destinationSymbol: d.destinationSymbol,
      unitsRequired: d.unitsRequired,
      unitsFulfilled: d.unitsFulfilled,
    })),
    declined: contracts.isDeclined(c.id),
    abandoned: contracts.isAbandoned(c.id),
  }));
}

export function attentionView(fleet: FleetManager) {
  const snap = fleet.attention.snapshot();
  return {
    asOf: snap.asOf ? new Date(snap.asOf).toISOString() : null,
    enabled: snap.enabled,
    modelConfigured: snap.modelConfigured,
    count: snap.items.length,
    items: snap.items,
  };
}

export async function keepersView(fleet: FleetManager) {
  return {
    markets: await fleet.keeperPriorityMarkets(),
    stations: fleet.keeperStations(),
    keeperCount: fleet.doctrine.value("keeperCount", 0),
    coverList: await fleet.keeperCoverList(),
  };
}

/** Everything the programme sections show. A part that fails is null, so the screen keeps what it had for that part. */
export async function programmeView(fleet: FleetManager, contracts: ContractManager | undefined) {
  const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [contractList, missions, feeds, chains, chainHealth] = await Promise.all([
    contracts ? safe(contractsView(contracts)) : Promise.resolve(null),
    safe(fleet.getMissions()),
    safe(fleet.getFeeds()),
    safe(fleet.getFeedChains()),
    safe(fleet.chainHealth()),
  ]);
  return { contracts: contractList, missions, feeds, chains, chainHealth };
}
