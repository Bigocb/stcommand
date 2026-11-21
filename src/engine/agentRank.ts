/**
 * The agent's rank by credits among every agent in the public directory (operator request, 2026-11-21: "the current rank
 * for the agent" in the Tower and Deck top bars).
 *
 * The directory comes from the galaxy crawler's hourly pass over GET /agents (agent_credit_snapshots), so other agents'
 * credits are up to an hour old. Our own figure is replaced by the live wallet when the caller has one, so the rank moves
 * with our trading between passes. Rank = 1 + the number of agents with strictly more credits (ties share a rank).
 *
 * Pure: no I/O, no clock.
 */

export interface DirectoryAgent { symbol: string; credits: number }

export interface AgentRank {
  rank: number;
  /** Agents ranked, ourselves included. */
  of: number;
  credits: number;
  /** The agent one place above us and how many credits it is ahead; undefined at rank 1. */
  nextUp?: { symbol: string; credits: number; gap: number };
  /** The agent at rank 1 (ourselves when we lead). */
  leader: { symbol: string; credits: number };
}

export function rankAgent(directory: readonly DirectoryAgent[], self: string, liveCredits?: number): AgentRank | undefined {
  const me = self.toUpperCase();
  const others = directory.filter((a) => a.symbol.toUpperCase() !== me && Number.isFinite(a.credits));
  const listed = directory.find((a) => a.symbol.toUpperCase() === me);
  const credits = liveCredits !== undefined && Number.isFinite(liveCredits) ? liveCredits : listed?.credits;
  if (credits === undefined) return undefined;
  const above = others.filter((a) => a.credits > credits).sort((a, b) => a.credits - b.credits);
  const top = [...others].sort((a, b) => b.credits - a.credits)[0];
  const leader = top && top.credits > credits ? { symbol: top.symbol, credits: top.credits } : { symbol: listed?.symbol ?? self, credits };
  const next = above[0];
  return {
    rank: above.length + 1,
    of: others.length + 1,
    credits,
    ...(next ? { nextUp: { symbol: next.symbol, credits: next.credits, gap: next.credits - credits } } : {}),
    leader,
  };
}
