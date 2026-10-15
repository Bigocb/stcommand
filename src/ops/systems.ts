/**
 * Candidate systems for the Systems tab: gathers each system's facts from what we know (the galaxy graph, gate status,
 * shipyard listings, the dispatcher's routes, our ships) and hands them to the pure judge (src/engine/systems/candidates.ts).
 * Advisory only: nothing here moves a ship.
 */
import type { TenantWorker } from "../engine/tenantRegistry.js";
import { judgeSystems, DEFAULT_CANDIDATE_POLICY, type CandidatePolicy, type CandidateVerdict, type SystemFacts } from "../engine/systems/candidates.js";

const TRADING_HULL = /HAULER|FREIGHTER|SHUTTLE/;
const systemOf = (waypoint: string) => waypoint.slice(0, waypoint.lastIndexOf("-"));

export async function systemCandidates(w: TenantWorker, policy: CandidatePolicy = DEFAULT_CANDIDATE_POLICY): Promise<{ asOf: string; policy: CandidatePolicy; verdicts: CandidateVerdict[] }> {
  const [graph, gates, yards] = await Promise.all([w.store.opsGalaxyGraph(), w.store.opsGateStatus(), w.store.shipyardInventory()]);
  const routes = w.fleet.dispatcher.explain()?.routes ?? [];
  const ours = w.fleet.fleetStatusSummary();
  const ourSystems = new Map<string, number>();
  for (const s of ours) {
    const sys = systemOf(s.waypoint ?? "");
    if (sys) ourSystems.set(sys, (ourSystems.get(sys) ?? 0) + 1);
  }

  // Gate hops from the nearest system we have a ship in (multi-source breadth-first search over the known gates).
  const adj = new Map<string, string[]>();
  for (const g of graph) adj.set(g.system, [...new Set(g.gates.flatMap((x) => x.to))]);
  const hops = new Map<string, number>();
  let frontier = [...ourSystems.keys()];
  for (const s of frontier) hops.set(s, 0);
  for (let d = 1; frontier.length && d <= policy.maxHops; d++) {
    const next: string[] = [];
    for (const s of frontier) for (const n of adj.get(s) ?? []) if (!hops.has(n)) { hops.set(n, d); next.push(n); }
    frontier = next;
  }

  const hullBySystem = new Map<string, boolean>();
  for (const y of yards) {
    if (TRADING_HULL.test(y.shipType)) hullBySystem.set(y.systemSymbol, true);
    else if (!hullBySystem.has(y.systemSymbol)) hullBySystem.set(y.systemSymbol, false);
  }
  const localBySystem = new Map<string, { n: number; best: number }>();
  for (const r of routes) {
    if (!r.buySystem || !r.sellAt || systemOf(r.sellAt) !== r.buySystem || !(r.profitPerTrip > 0)) continue;
    const cur = localBySystem.get(r.buySystem) ?? { n: 0, best: 0 };
    cur.n += 1;
    cur.best = Math.max(cur.best, r.profitPerTrip);
    localBySystem.set(r.buySystem, cur);
  }

  const facts: SystemFacts[] = graph.map((g) => {
    const gateSyms = g.gates.map((x) => x.gate);
    const local = localBySystem.get(g.system);
    return {
      system: g.system,
      hops: hops.get(g.system),
      gateComplete: gateSyms.length ? gateSyms.every((s) => gates.get(s) !== false) : undefined,
      surveyed: g.priced > 0,
      markets: g.markets,
      // A system with yards but no listing for them yet is unknown, not "no hull".
      hullYard: hullBySystem.get(g.system) ?? (g.shipyards === 0 ? false : undefined),
      localRoutes: local?.n ?? 0,
      bestLocalProfit: local?.best ?? 0,
      ourShips: ourSystems.get(g.system) ?? 0,
    };
  });
  return { asOf: new Date().toISOString(), policy, verdicts: judgeSystems(facts, policy) };
}
