/**
 * A tiny process-wide TTL cache for public, tenant-agnostic API responses
 * (the leaderboard, factions) — every tenant's dashboard would otherwise
 * re-fetch and re-paginate the same global data on every poll, competing
 * with that tenant's own fleet for the shared per-token rate limit for no
 * benefit (the data itself doesn't change tenant to tenant, or often at
 * all). One key, one entry, shared across every request — not a generic
 * multi-entry cache, since nothing here needs one.
 */
export function makeTTLCache<Arg, T>(ttlMs: number, fetcher: (arg: Arg) => Promise<T>): (arg: Arg) => Promise<T> {
  let cached: T | undefined;
  let fetchedAt = 0;
  let inFlight: Promise<T> | undefined;
  return async (arg: Arg) => {
    if (cached !== undefined && Date.now() - fetchedAt < ttlMs) return cached;
    // Collapse concurrent callers (e.g. two tenants' dashboards polling at
    // the same moment on a cold cache) into one real fetch rather than one
    // per request. Whichever caller's `arg` (its own SpaceTradersAPI, in
    // practice) happens to win the race is fine — this is public,
    // tenant-agnostic data, so it doesn't matter whose token made the call.
    if (inFlight) return inFlight;
    inFlight = fetcher(arg)
      .then((value) => {
        cached = value;
        fetchedAt = Date.now();
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
