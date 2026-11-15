// When the dispatcher's core tick may reuse the last route list instead of rebuilding it.
//
// 2026-11-15: with ~20 live systems a route pass takes ~15 s and the dispatcher's recompute another ~20 s, so the single
// Node process runs flat out and keeper reads fall to 12/min against a demand of ~100/min. Prices move on a ~30 minute tick,
// so a list a minute old is nearly as good as a new one. This decides, from how long the last build took, whether to reuse it.
//
// Pure: no clock, no I/O. Off (maxAgeSec 0) reproduces today's behaviour: always rebuild.

export interface RouteReusePolicy {
  /** Longest a reused list may be, seconds. 0 = never reuse. */
  maxAgeSec: number;
  /** A build shorter than this is cheap enough to repeat, ms. */
  minBuildMs: number;
}

export const DEFAULT_ROUTE_REUSE_POLICY: RouteReusePolicy = { maxAgeSec: 0, minBuildMs: 5_000 };

export interface RouteReuseSignals {
  nowMs: number;
  /** When the held list was built, if any. */
  builtAtMs?: number;
  /** How long that build took. */
  buildMs?: number;
  /** Something changed that makes the held list wrong (wind-down toggled, a clause flipped): rebuild. */
  invalidated?: boolean;
}

export interface RouteReuseDecision {
  reuse: boolean;
  reason: string;
}

export function decideRouteReuse(sig: RouteReuseSignals, policy: RouteReusePolicy): RouteReuseDecision {
  if (!(policy.maxAgeSec > 0)) return { reuse: false, reason: "reuse is off" };
  if (sig.invalidated) return { reuse: false, reason: "held list invalidated" };
  if (sig.builtAtMs === undefined || sig.buildMs === undefined) return { reuse: false, reason: "no held list yet" };
  if (sig.buildMs < policy.minBuildMs) return { reuse: false, reason: `last build took ${Math.round(sig.buildMs)} ms, cheap enough to repeat` };
  const ageMs = sig.nowMs - sig.builtAtMs;
  // Allow a list up to twice the build time old, never past the ceiling: a slower build earns a longer reuse.
  const allowMs = Math.min(policy.maxAgeSec * 1000, sig.buildMs * 2);
  if (ageMs < 0) return { reuse: false, reason: "held list is from the future" };
  if (ageMs >= allowMs) return { reuse: false, reason: `held list is ${Math.round(ageMs / 1000)}s old, over ${Math.round(allowMs / 1000)}s` };
  return { reuse: true, reason: `reusing a ${Math.round(ageMs / 1000)}s old list (build took ${Math.round(sig.buildMs / 1000)}s)` };
}
