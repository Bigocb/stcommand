/**
 * Loop keepers: the touring half of the keeper tour plan (issue #63, part 2).
 *
 * The plan (keeperPlan.ts) leaves a system's low-value markets to touring. A loop keeper is an ordinary stationed keeper whose pin
 * moves to the next of those markets after every read, with no wait and no dock in between, so one hull keeps a whole system's
 * tour-only markets fresh instead of one keeper per market. Loop keepers are made from demoted keepers (no purchase). A system gets
 * one; when a lap takes longer than the target, a second one joins and the markets are split between them.
 *
 * Pure: no I/O, no clock, no globals. The caller saves the state (fleet flag keeperLoops) on every change and restores it at boot.
 */

export interface LoopKeeper {
  ship: string;
  system: string;
  /** This loop's share of the system's tour-only markets, in visiting order. */
  markets: string[];
  /** Index of the market the keeper is pinned to now. */
  idx: number;
  /** When the current lap started, and how long the last full lap took. */
  lapStartMs: number;
  lastLapMs?: number;
}

export interface LoopPolicy {
  /** A system needs at least this many tour-only markets before a loop keeper is worth it. */
  minTourMarkets: number;
  /** A lap slower than this adds a second loop keeper to the system (if a demoted hull is free there). */
  lapTargetMs: number;
  /** Loop keepers per system at most. */
  maxPerSystem: number;
  /** New loop keepers made per pass at most. */
  maxNewPerPass: number;
}

export const DEFAULT_LOOP_POLICY: LoopPolicy = { minTourMarkets: 3, lapTargetMs: 30 * 60_000, maxPerSystem: 2, maxNewPerPass: 3 };

export interface LoopInput {
  nowMs: number;
  /** Per system, its tour-only markets (from the plan). */
  tourMarkets: ReadonlyMap<string, readonly string[]>;
  /** Demoted keepers free to become loop keepers, with their system and current market. */
  free: readonly { ship: string; system: string; market: string }[];
  loops: readonly LoopKeeper[];
}

export interface LoopDecision {
  /** The loops after this pass (new ones added, market lists refreshed, dropped ones removed). */
  loops: LoopKeeper[];
  /** Hulls turned into loop keepers this pass, with the market they start on. */
  created: { ship: string; system: string; start: string; reason: string }[];
  /** Loops ended (their system no longer has enough tour-only markets). */
  ended: { ship: string; system: string; reason: string }[];
}

/** Split a system's markets between `n` loops: loop k takes every n-th market starting at k, so each covers the whole system. */
export function shareOf(markets: readonly string[], k: number, n: number): string[] {
  return markets.filter((_, i) => i % n === k);
}

export function planLoops(input: LoopInput, p: LoopPolicy = DEFAULT_LOOP_POLICY): LoopDecision {
  const created: LoopDecision["created"] = [];
  const ended: LoopDecision["ended"] = [];
  const bySystem = new Map<string, LoopKeeper[]>();
  for (const l of input.loops) bySystem.set(l.system, [...(bySystem.get(l.system) ?? []), { ...l, markets: [...l.markets] }]);
  const usedShips = new Set(input.loops.map((l) => l.ship));
  const out: LoopKeeper[] = [];
  const systems = new Set([...bySystem.keys(), ...input.tourMarkets.keys()]);
  for (const system of [...systems].sort()) {
    const markets = [...(input.tourMarkets.get(system) ?? [])].sort();
    let loops = bySystem.get(system) ?? [];
    if (markets.length < p.minTourMarkets) {
      for (const l of loops) ended.push({ ship: l.ship, system, reason: `${markets.length} tour-only markets left (under ${p.minTourMarkets})` });
      continue;
    }
    const slow = loops.length > 0 && loops.length < p.maxPerSystem && loops.every((l) => l.lastLapMs !== undefined && l.lastLapMs > p.lapTargetMs);
    const want = loops.length === 0 ? 1 : slow ? loops.length + 1 : loops.length;
    while (loops.length < want && created.length < p.maxNewPerPass) {
      const hull = input.free.find((f) => f.system === system && !usedShips.has(f.ship));
      if (!hull) break;
      usedShips.add(hull.ship);
      const why = loops.length === 0
        ? `${markets.length} tour-only markets and no loop keeper`
        : `last lap ${Math.round((loops[0]!.lastLapMs ?? 0) / 60_000)} min, over ${Math.round(p.lapTargetMs / 60_000)}`;
      loops = [...loops, { ship: hull.ship, system, markets: [], idx: 0, lapStartMs: input.nowMs }];
      created.push({ ship: hull.ship, system, start: "", reason: why });
    }
    // Refresh every loop's share: markets come and go as routes promote and demote them.
    loops.forEach((l, k) => {
      const share = shareOf(markets, k, loops.length);
      const current = l.markets[l.idx];
      l.markets = share;
      const at = current ? share.indexOf(current) : -1;
      l.idx = at >= 0 ? at : 0;
    });
    for (const c of created) if (c.system === system) c.start = loops.find((l) => l.ship === c.ship)?.markets[0] ?? "";
    out.push(...loops);
  }
  return { loops: out, created: created.filter((c) => c.start), ended };
}

/** After a read: the next market to pin, and the loop's lap bookkeeping. Returns undefined for an empty loop. */
export function advanceLoop(l: LoopKeeper, nowMs: number): { loop: LoopKeeper; next: string } | undefined {
  if (!l.markets.length) return undefined;
  const nextIdx = (l.idx + 1) % l.markets.length;
  const lapDone = nextIdx === 0;
  const loop: LoopKeeper = {
    ...l,
    idx: nextIdx,
    lapStartMs: lapDone ? nowMs : l.lapStartMs,
    lastLapMs: lapDone ? nowMs - l.lapStartMs : l.lastLapMs,
  };
  return { loop, next: l.markets[nextIdx]! };
}

export function encodeLoops(loops: readonly LoopKeeper[]): string {
  return JSON.stringify(loops);
}

export function decodeLoops(raw: string | undefined | null): LoopKeeper[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    return j.filter((x): x is LoopKeeper =>
      !!x && typeof x.ship === "string" && typeof x.system === "string" && Array.isArray(x.markets) && typeof x.idx === "number" && typeof x.lapStartMs === "number");
  } catch {
    return [];
  }
}
