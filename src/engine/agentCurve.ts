/**
 * Agent curve: how every agent's credits moved hour by hour, from the public leaderboard samples (agent_samples, written by the agent
 * watcher about every 15-30 minutes). Built to answer "are the other traders seeing the same dip?" (operator, 2026-11-25).
 *
 * Pure. Credits change is a proxy for earnings, not a measure of them: buying a ship lowers credits, so an agent that buys hulls looks
 * worse in that hour. The ship count is given next to it so a fall can be read against purchases.
 */

export interface AgentSample { agent: string; at: number; credits: number; ships: number }

export interface AgentCurveRow {
  agent: string;
  creditsNow: number;
  shipsNow: number;
  /** Credits change per bucket, oldest first (null = no sample in that bucket or the one before). */
  deltas: (number | null)[];
  shipsAdded: (number | null)[];
  /** Mean credits change per hour before and after the pivot, and the ratio after/before (null when either side has no data). */
  beforePerHour: number | null;
  afterPerHour: number | null;
  ratio: number | null;
}

export interface AgentCurve {
  buckets: string[];
  pivot: string | null;
  rows: AgentCurveRow[];
  /** Agents with a positive rate before the pivot: how many fell by more than half after it, and the median ratio. */
  summary: { compared: number; fellOverHalf: number; medianRatio: number | null } | null;
}

/** Last sample at or before t, from samples sorted by time. */
function at(samples: readonly AgentSample[], t: number): AgentSample | undefined {
  let best: AgentSample | undefined;
  for (const s of samples) { if (s.at <= t) best = s; else break; }
  return best;
}

function ratePerHour(samples: readonly AgentSample[], from: number, to: number): number | null {
  const a = at(samples, from), b = at(samples, to);
  if (!a || !b || b.at - a.at < 30 * 60_000) return null;
  return ((b.credits - a.credits) / (b.at - a.at)) * 3_600_000;
}

export function agentCurve(samples: readonly AgentSample[], opts: { fromMs: number; toMs: number; bucketMin?: number; top?: number; pivotMs?: number; agentFilter?: string }): AgentCurve {
  const bucketMs = Math.max(15, opts.bucketMin ?? 60) * 60_000;
  const edges: number[] = [];
  for (let t = opts.fromMs; t <= opts.toMs; t += bucketMs) edges.push(t);
  const byAgent = new Map<string, AgentSample[]>();
  for (const s of samples) (byAgent.get(s.agent) ?? byAgent.set(s.agent, []).get(s.agent)!).push(s);
  const needle = opts.agentFilter?.toLowerCase();
  const rows: AgentCurveRow[] = [];
  for (const [agent, list] of byAgent) {
    if (needle && !agent.toLowerCase().includes(needle)) continue;
    list.sort((x, y) => x.at - y.at);
    const last = list[list.length - 1]!;
    const deltas: (number | null)[] = [];
    const shipsAdded: (number | null)[] = [];
    for (let i = 1; i < edges.length; i++) {
      const a = at(list, edges[i - 1]!), b = at(list, edges[i]!);
      const ok = a && b && b.at > a.at && b.at > edges[i - 1]!;
      deltas.push(ok ? b!.credits - a!.credits : null);
      shipsAdded.push(ok ? b!.ships - a!.ships : null);
    }
    let before: number | null = null, after: number | null = null;
    if (opts.pivotMs !== undefined) {
      const span = Math.min(opts.pivotMs - opts.fromMs, opts.toMs - opts.pivotMs);
      if (span >= 30 * 60_000) {
        before = ratePerHour(list, opts.pivotMs - span, opts.pivotMs);
        after = ratePerHour(list, opts.pivotMs, opts.pivotMs + span);
      }
    }
    rows.push({
      agent, creditsNow: last.credits, shipsNow: last.ships, deltas, shipsAdded,
      beforePerHour: before === null ? null : Math.round(before), afterPerHour: after === null ? null : Math.round(after),
      ratio: before !== null && after !== null && before > 0 ? Math.round((after / before) * 100) / 100 : null,
    });
  }
  rows.sort((x, y) => y.creditsNow - x.creditsNow || x.agent.localeCompare(y.agent));
  const top = rows.slice(0, Math.max(1, opts.top ?? 15));
  let summary: AgentCurve["summary"] = null;
  if (opts.pivotMs !== undefined) {
    const ratios = top.map((r) => r.ratio).filter((r): r is number => r !== null).sort((x, y) => x - y);
    summary = { compared: ratios.length, fellOverHalf: ratios.filter((r) => r < 0.5).length, medianRatio: ratios.length ? ratios[Math.floor((ratios.length - 1) / 2)]! : null };
  }
  return { buckets: edges.slice(1).map((t) => new Date(t).toISOString()), pivot: opts.pivotMs !== undefined ? new Date(opts.pivotMs).toISOString() : null, rows: top, summary };
}
