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

/**
 * A keyed TTL cache for heavy per-tenant dashboard reads (issue #87): /api/metrics, /api/compare, /api/markets. Every open
 * screen polls these, Deck and Tower at once, and each request used to rebuild the whole answer (a week of ledger rows, every
 * ship's status). With this, one build serves every caller for `ttlMs`, and concurrent callers on a cold key share one build.
 *
 * A pure cache of a rebuildable answer, so it lives in memory on purpose (CLAUDE.md: nothing a decision reads). A failed build
 * is not cached. `ttlMs` may depend on the key (a finished week never changes; the live one does). Oldest entries are dropped
 * past `maxEntries`, so a caller cycling through many keys cannot grow it without bound.
 */
export interface KeyedCacheOptions<K> {
  ttlMs: number | ((key: K) => number);
  maxEntries?: number;
  now?: () => number;
}

export interface KeyedCache<K, T> {
  get(key: K, build: () => Promise<T>): Promise<T>;
  /** Entries held now (for tests and the endpoint stats). */
  size(): number;
  clear(): void;
}

export function keyedTtlCache<K, T>(opts: KeyedCacheOptions<K>): KeyedCache<K, T> {
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? 64;
  const ttl = (k: K) => (typeof opts.ttlMs === "function" ? opts.ttlMs(k) : opts.ttlMs);
  const done = new Map<K, { value: T; at: number }>();
  const inFlight = new Map<K, Promise<T>>();
  return {
    async get(key, build) {
      const hit = done.get(key);
      if (hit && now() - hit.at < ttl(key)) return hit.value;
      const running = inFlight.get(key);
      if (running) return running;
      const p = build()
        .then((value) => {
          done.delete(key);
          done.set(key, { value, at: now() });
          while (done.size > max) done.delete(done.keys().next().value as K);
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
    size: () => done.size,
    clear: () => { done.clear(); inFlight.clear(); },
  };
}

/** Thrown inside a cached build to answer with a status other than 500 (the error is not cached). */
export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
