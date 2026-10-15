/**
 * Candidate systems: which systems are worth moving a ship into next, and why (advisory only).
 *
 * Pure. The ops layer (src/ops/systems.ts) reads the galaxy graph, gate status, shipyard listings and the dispatcher's
 * routes, and hands each system's facts here. Nothing here moves a ship or buys anything.
 *
 * A system whose shipyards and markets have never been seen is "unsurveyed": its local routes and hull access are
 * unknown until a ship visits, so it is listed as a survey target, not a candidate. Criteria are policy data, so the
 * list can be tuned without changing code.
 */

export interface SystemFacts {
  system: string;
  /** Gate hops from the nearest ship we have. Undefined when no path through known gates reaches it. */
  hops: number | undefined;
  /** Whether every gate in the system is finished. Undefined when the gate data is missing. */
  gateComplete: boolean | undefined;
  /** Whether any market in the system has been priced (so its routes can be judged). */
  surveyed: boolean;
  markets: number;
  /** Whether a shipyard here sells a hull that can trade. Undefined when no shipyard listing is known. */
  hullYard: boolean | undefined;
  /** Same-system routes on the dispatcher's board that make a profit. */
  localRoutes: number;
  bestLocalProfit: number;
  /** Ships of ours in the system right now. */
  ourShips: number;
}

export interface CandidatePolicy {
  /** Furthest a candidate may be, in gate hops from our ships. */
  maxHops: number;
  /** Exclude systems whose gates are not all finished. */
  requireGateComplete: boolean;
  /** Surveyed systems need at least this many profitable local routes to be a candidate. */
  minLocalRoutes: number;
  /** Exclude surveyed systems with no yard selling a trading hull. */
  requireHullYard: boolean;
  /** Profit per trip at which the local-route score stops growing. */
  profitCap: number;
  /** Points for each factor, 0 to switch it off. */
  weights: { localProfit: number; hullYard: number; hops: number };
}

export const DEFAULT_CANDIDATE_POLICY: CandidatePolicy = {
  maxHops: 2,
  requireGateComplete: true,
  minLocalRoutes: 1,
  requireHullYard: false,
  profitCap: 100_000,
  weights: { localProfit: 60, hullYard: 20, hops: 20 },
};

export type CandidateStatus = "candidate" | "excluded" | "unsurveyed";

export interface CandidateVerdict {
  system: string;
  status: CandidateStatus;
  /** 0 to 100. Only candidates are ranked by it; the others carry a score for reference. */
  score: number;
  /** One line per decision, for the operator to read. */
  reasons: string[];
  facts: SystemFacts;
}

/** Score and explain every system. Candidates come first, best score first; then survey targets; then exclusions. */
export function judgeSystems(facts: readonly SystemFacts[], policy: CandidatePolicy = DEFAULT_CANDIDATE_POLICY): CandidateVerdict[] {
  const order: Record<CandidateStatus, number> = { candidate: 0, unsurveyed: 1, excluded: 2 };
  return facts
    .map((f) => judgeOne(f, policy))
    .sort((a, b) => order[a.status] - order[b.status] || b.score - a.score || a.system.localeCompare(b.system));
}

function judgeOne(f: SystemFacts, p: CandidatePolicy): CandidateVerdict {
  const reasons: string[] = [];
  const excluded = (why: string): CandidateVerdict => ({ system: f.system, status: "excluded", score: 0, reasons: [why], facts: f });

  if (f.hops === undefined) return excluded("no known gate path from our ships");
  if (f.hops > p.maxHops) return excluded(`${f.hops} gate hops away (limit ${p.maxHops})`);
  reasons.push(`${f.hops} gate hop${f.hops === 1 ? "" : "s"} from our ships`);

  if (p.requireGateComplete) {
    if (f.gateComplete === undefined) return excluded("no gate data for this system");
    if (!f.gateComplete) return excluded("a gate here is not finished, so ships can't jump in");
  }
  if (f.gateComplete) reasons.push("gate finished");

  if (!f.surveyed) {
    // Nothing is known about its markets or yards yet, so it can't be scored: it's a survey target.
    return { system: f.system, status: "unsurveyed", score: 0, reasons: [...reasons, "not surveyed: markets and shipyards are unknown until a ship visits"], facts: f };
  }

  if (f.localRoutes < p.minLocalRoutes) return excluded(`${f.localRoutes} profitable local route${f.localRoutes === 1 ? "" : "s"} (need ${p.minLocalRoutes})`);
  reasons.push(`${f.localRoutes} profitable local route${f.localRoutes === 1 ? "" : "s"}, best ${Math.round(f.bestLocalProfit).toLocaleString("en-US")} a trip`);

  if (p.requireHullYard && f.hullYard !== true) return excluded("no yard here sells a trading hull");
  if (f.hullYard === true) reasons.push("a yard here sells a trading hull");
  else if (f.hullYard === undefined) reasons.push("shipyard listing unknown");

  const localPart = p.weights.localProfit * Math.min(1, Math.max(0, f.bestLocalProfit) / p.profitCap);
  const hullPart = p.weights.hullYard * (f.hullYard === true ? 1 : 0);
  const hopsPart = p.weights.hops * (1 - f.hops / (p.maxHops + 1));
  const total = localPart + hullPart + hopsPart;
  const cap = p.weights.localProfit + p.weights.hullYard + p.weights.hops;
  const score = cap > 0 ? Math.round((total / cap) * 100) : 0;
  return { system: f.system, status: "candidate", score, reasons, facts: f };
}
