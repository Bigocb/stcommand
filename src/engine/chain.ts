/**
 * Chains: scoring a route by what the ship can do AFTER it sells. See docs/backhaul-plan.md.
 *
 * The dispatcher ranks each route on its own, from where the ship stands. A route that ends next to a good follow-on
 * (a buy market with a worthwhile trip starting there) leaves the ship loaded sooner than one that ends in a dead end,
 * but nothing credited that. v1 adds the best follow-on's score, weighted, to the route's own. The trader is unchanged:
 * after the sale it picks its next route as usual, and a route starting where it stands has ~zero positioning, so the
 * follow-on wins by itself.
 *
 * Pure: no I/O, no clock. Everything the dispatcher already knows (distance, gate links, reservations) comes in through
 * `ChainContext`, so this and the dispatcher cannot disagree about what is reachable or what a positioning leg costs.
 * Later versions (committed circuits, longer chains) grow inside this file behind the same entry points.
 */

/** The fields of a dispatcher work item this module reads. A direct (buy at A, sell at B) route. */
export interface ChainCandidate {
  key: string;
  good: string;
  buyAt: string;
  buySystem: string;
  sellAt: string;
  /** The dispatcher's ranking score for this route (profit per trip, scaled to the reference trip length). */
  profitPerTrip: number;
  tripSeconds: number;
  secPerDist: number;
}

/**
 * Seconds a ship is stuck after one gate jump (the jump's own cooldown: ~599s seen live 2026-10-09 on every trader that
 * had just jumped). A trip's profit is scored per unit of time, so a jump is a long empty stretch, not just credits.
 */
export const JUMP_COOLDOWN_SECONDS = 600;

/** Placeholder: seconds of in-system flying a one-way cross-system trip adds to its jump cooldowns (to the gate in the
 *  buy system, from the gate to the market in the sell system). Tune against real trip times. */
export const CROSS_SYSTEM_FLIGHT_SECONDS = 240;

export interface ChainPolicy {
  /** Share (0..1) of the follow-on's score credited to the route. 0 switches the whole feature off. */
  followOnWeight: number;
  /** A follow-on that would start more than this long after the sale (positioning flight) is ignored. */
  horizonMinutes: number;
  /** A follow-on may be credited to only one trader per dispatch cycle. */
  reserveFollowOn: boolean;
  /** Empty seconds charged for each gate jump a follow-on needs (the ship sits out the jump cooldown). */
  jumpSeconds: number;
}

export const DEFAULT_CHAIN_POLICY: ChainPolicy = { followOnWeight: 0, horizonMinutes: 15, reserveFollowOn: true, jumpSeconds: JUMP_COOLDOWN_SECONDS };

export interface ChainContext {
  /** Straight-line distance between two waypoints in one system. */
  distanceBetween: (a: string, b: string) => number;
  /**
   * Cost in credits of reaching `toSystem` from `fromSystem` (a jump or a verified multi-hop path), or undefined if
   * it cannot be done. Only called for different systems.
   */
  crossSystemCost: (fromSystem: string, toSystem: string) => number | undefined;
  /** Gate jumps from one system to another (1 for a single hop), when known; used to charge the cooldown time. */
  crossSystemHops?: (fromSystem: string, toSystem: string) => number | undefined;
  /** True when this follow-on may not be used (already assigned this cycle, reserved by another chain, refused...). */
  unavailable: (candidate: ChainCandidate) => boolean;
}

export interface FollowOn {
  candidate: ChainCandidate;
  /** The follow-on's own score from where the ship will stand, before the policy weight. */
  score: number;
  /** Seconds of empty flight from the sell market to the follow-on's buy market, including the cooldown of any gate jump. */
  positioningSeconds: number;
}

const systemOf = (waypoint: string): string => waypoint.slice(0, waypoint.lastIndexOf("-"));

/**
 * The best route a ship could start right after selling at `sellAt`, scored the way the dispatcher scores an idle
 * trader's pick: the route's score, times trip/(trip + positioning) for the empty leg, minus a third of any jump cost.
 */
export function bestFollowOn(
  sellAt: string,
  candidates: readonly ChainCandidate[],
  ctx: ChainContext,
  policy: ChainPolicy,
  excludeKey?: string,
): FollowOn | undefined {
  const here = systemOf(sellAt);
  let best: FollowOn | undefined;
  for (const c of candidates) {
    if (c.key === excludeKey || ctx.unavailable(c)) continue;
    if (c.profitPerTrip <= 0 || c.tripSeconds <= 0) continue;
    let score = c.profitPerTrip;
    let positioningSeconds = 0;
    if (c.buySystem === here) {
      positioningSeconds = ctx.distanceBetween(sellAt, c.buyAt) * c.secPerDist;
      if (!Number.isFinite(positioningSeconds)) continue;
      if (positioningSeconds > policy.horizonMinutes * 60) continue;
      score *= c.tripSeconds / (c.tripSeconds + positioningSeconds);
    } else {
      const cost = ctx.crossSystemCost(here, c.buySystem);
      if (cost === undefined) continue;
      // A jump is credits AND time: the ship sits out the cooldown before it can buy. Charge it like any other empty
      // flight, so a cross-system follow-on still counts when its profit justifies the wait, and not when it does not.
      positioningSeconds = (ctx.crossSystemHops?.(here, c.buySystem) ?? 1) * policy.jumpSeconds;
      if (positioningSeconds > policy.horizonMinutes * 60) continue;
      score *= c.tripSeconds / (c.tripSeconds + positioningSeconds);
      score -= cost / 3;
    }
    if (score <= 0) continue;
    if (!best || score > best.score) best = { candidate: c, score, positioningSeconds };
  }
  return best;
}

/** The route's score including its follow-on credit. With weight 0, or no follow-on, it is the plain score. */
export function chainScore(baseScore: number, followOn: FollowOn | undefined, policy: ChainPolicy): number {
  if (!followOn || policy.followOnWeight <= 0) return baseScore;
  return baseScore + policy.followOnWeight * followOn.score;
}

/** One line for logs and tools: why this route was credited. */
export function explainChain(baseScore: number, followOn: FollowOn | undefined, policy: ChainPolicy): string {
  if (policy.followOnWeight <= 0) return "follow-on lookahead off";
  if (!followOn) return `score ${Math.round(baseScore)}, no follow-on from its sell market`;
  const c = followOn.candidate;
  return `score ${Math.round(baseScore)} + ${policy.followOnWeight} x ${Math.round(followOn.score)} (then ${c.good}: buy ${c.buyAt}, sell ${c.sellAt}, ${Math.round(followOn.positioningSeconds)}s empty)`;
}
