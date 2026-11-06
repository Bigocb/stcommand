import { hostname } from "node:os";
import type { LimiterStats } from "./client.js";

/** Identity of this server process — Render sets RENDER_INSTANCE_ID per instance. */
export const INSTANCE_ID = process.env.RENDER_INSTANCE_ID ?? `${hostname()}-${process.pid}`;

const WINDOW_MS = 60_000;

/**
 * Process-wide count of SpaceTraders 429 responses over a rolling minute.
 * Fed by the API client's `onRateLimited` hook (every tenant shares one
 * limit, so one counter for the whole process is the honest unit) and read by
 * `GET /api/rate-limit` for the Tower/Deck indicator. Each hit also says who
 * made the call (an agent symbol, or "crawler (no token)" for the tokenless
 * public fetches) and keeps the rate-limit headers of the latest 429 per
 * source: SpaceTraders' own words on what limit was hit (see snapshot().last).
 */
export class RateLimitMonitor {
  private hits: { t: number; source: string }[] = [];
  private lastBySource = new Map<string, { at: string; headers: Record<string, string> }>();
  private last = 0;
  private limiterSource: (() => LimiterStats) | undefined;
  private laneSource: (() => Record<string, unknown>) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** One 429. `source` says who was rate limited; `headers` are the response's rate-limit headers, when the caller has them. */
  record(source = "unknown", headers?: Record<string, string>): void {
    const t = this.now();
    this.hits.push({ t, source });
    this.last = t;
    if (headers && Object.keys(headers).length) this.lastBySource.set(source, { at: new Date(t).toISOString(), headers });
    this.prune(t);
  }

  private prune(t: number): void {
    const cutoff = t - WINDOW_MS;
    let i = 0;
    while (i < this.hits.length && this.hits[i]!.t < cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
  }

  /** Where to read the shared token bucket's demand/wait numbers from (the TenantRegistry registers it). */
  setLimiterSource(fn: () => LimiterStats): void {
    this.limiterSource = fn;
  }

  /** Where to read the proxy lane's own numbers from (apiLanes.ts); not set when no lane proxy is configured. */
  setLaneSource(fn: () => Record<string, unknown>): void {
    this.laneSource = fn;
  }

  snapshot(): { hits60s: number; bySource: Record<string, number>; last: Record<string, { at: string; headers: Record<string, string> }>; lastAt: string | null; limiter?: LimiterStats; lane?: Record<string, unknown> } {
    this.prune(this.now());
    const limiter = this.limiterSource?.();
    const lane = this.laneSource?.();
    const bySource: Record<string, number> = {};
    for (const h of this.hits) bySource[h.source] = (bySource[h.source] ?? 0) + 1;
    return { hits60s: this.hits.length, bySource, last: Object.fromEntries(this.lastBySource), lastAt: this.last ? new Date(this.last).toISOString() : null, ...(limiter ? { limiter } : {}), ...(lane ? { lane } : {}) };
  }
}

export const rateLimitMonitor = new RateLimitMonitor();

/** The rate-limit related headers of a response (x-ratelimit-*, retry-after), lower-cased, for the monitor. */
export function rateLimitHeaders(headers: { forEach(cb: (value: string, key: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { if (/rate|retry|limit/i.test(key)) out[key.toLowerCase()] = value; });
  return out;
}
