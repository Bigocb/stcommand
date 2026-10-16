// Pure sliding-window rate limiter. No clock, no I/O: the caller passes nowMs.

export type Bucket = 'account' | 'data' | 'action';
export interface WindowLimit { windowMs: number; max: number }
export type LimitPolicy = Record<Bucket, WindowLimit[]>;

const S = 1000, M = 60_000, H = 3_600_000;

/** Published limits (docs.artifactsmmo.com), per IP. */
export const DEFAULT_LIMITS: LimitPolicy = {
  account: [{ windowMs: S, max: 10 }, { windowMs: H, max: 300 }],
  data: [{ windowMs: S, max: 10 }, { windowMs: M, max: 200 }, { windowMs: H, max: 2000 }],
  action: [{ windowMs: S, max: 10 }, { windowMs: M, max: 100 }, { windowMs: H, max: 5000 }],
};

export type Acquire = { ok: true } | { ok: false; waitMs: number; reason: string };

export interface Limiter {
  tryAcquire(bucket: Bucket, nowMs: number): Acquire;
  /** Requests currently counted in each window of a bucket (for tests/dashboards). */
  usage(bucket: Bucket, nowMs: number): { windowMs: number; used: number; allowed: number }[];
}

/**
 * Bucket mapping (reason: the API meters by endpoint family, so we mirror that):
 *  - action:  POST /my/{name}/action/*   (every game action, incl. bank/GE/task actions)
 *  - account: every other /my/* call about the account (bank, GE orders/history, rates,
 *             details, pending items, password/email...). Tightest hourly cap, so rarely polled.
 *  - data:    static data GETs (/items, /maps, ...), GET /, and character reads
 *             (/my/characters, /characters/*, /my/logs*), which are polled often.
 */
export function bucketFor(method: string, path: string): Bucket {
  const m = method.toUpperCase();
  const p = path.split('?')[0] ?? path;
  if (m === 'POST' && /^\/my\/[^/]+\/action\//.test(p)) return 'action';
  if (p === '/my/characters' || p.startsWith('/my/logs') || p.startsWith('/characters')) return 'data';
  if (p.startsWith('/my/')) return 'account';
  return 'data';
}

export interface LimiterOptions { limits?: LimitPolicy; headroom?: number }

export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const headroom = opts.headroom ?? 0.9;
  const allowedOf = (w: WindowLimit) => Math.max(1, Math.floor(w.max * headroom));
  const stamps: Record<Bucket, number[]> = { account: [], data: [], action: [] };

  const prune = (b: Bucket, nowMs: number) => {
    const longest = Math.max(...limits[b].map((w) => w.windowMs));
    const arr = stamps[b];
    let i = 0;
    while (i < arr.length && nowMs - arr[i]! >= longest) i++;
    if (i > 0) arr.splice(0, i);
  };
  // in window iff nowMs - t < windowMs, so a slot frees exactly at t + windowMs.
  const inWindow = (arr: number[], w: WindowLimit, nowMs: number) => {
    let first = arr.length;
    for (let i = 0; i < arr.length; i++) if (nowMs - arr[i]! < w.windowMs) { first = i; break; }
    return { first, count: arr.length - first };
  };

  return {
    tryAcquire(bucket, nowMs) {
      prune(bucket, nowMs);
      const arr = stamps[bucket];
      let waitMs = 0;
      let reason = '';
      for (const w of limits[bucket]) {
        const allowed = allowedOf(w);
        const { first, count } = inWindow(arr, w, nowMs);
        if (count >= allowed) {
          const free = arr[first + count - allowed]! + w.windowMs - nowMs;
          if (free > waitMs) {
            waitMs = free;
            reason = `${bucket} bucket: ${count}/${allowed} used in ${w.windowMs}ms window (limit ${w.max}, headroom ${headroom})`;
          }
        }
      }
      if (waitMs > 0) return { ok: false, waitMs, reason };
      arr.push(nowMs);
      return { ok: true };
    },
    usage(bucket, nowMs) {
      prune(bucket, nowMs);
      return limits[bucket].map((w) => ({
        windowMs: w.windowMs, used: inWindow(stamps[bucket], w, nowMs).count, allowed: allowedOf(w),
      }));
    },
  };
}
