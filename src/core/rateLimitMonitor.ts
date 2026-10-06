import { hostname } from "node:os";
import type { LimiterStats } from "./client.js";

/** Identity of this server process — Render sets RENDER_INSTANCE_ID per instance. */
export const INSTANCE_ID = process.env.RENDER_INSTANCE_ID ?? `${hostname()}-${process.pid}`;

const WINDOW_MS = 60_000;

/**
 * Process-wide count of SpaceTraders 429 responses over a rolling minute.
 * Fed by the API client's `onRateLimited` hook (every tenant shares this one
 * IP's limit, so one counter for the whole process is the honest unit) and
 * read by `GET /api/rate-limit` for the Tower/Deck indicator.
 */
export class RateLimitMonitor {
  private hits: number[] = [];
  private last = 0;
  private limiterSource: (() => LimiterStats) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  record(): void {
    const t = this.now();
    this.hits.push(t);
    this.last = t;
    this.prune(t);
  }

  private prune(t: number): void {
    const cutoff = t - WINDOW_MS;
    let i = 0;
    while (i < this.hits.length && this.hits[i]! < cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
  }

  /** Where to read the shared token bucket's demand/wait numbers from (the TenantRegistry registers it). */
  setLimiterSource(fn: () => LimiterStats): void {
    this.limiterSource = fn;
  }

  snapshot(): { hits60s: number; lastAt: string | null; limiter?: LimiterStats } {
    this.prune(this.now());
    const limiter = this.limiterSource?.();
    return { hits60s: this.hits.length, lastAt: this.last ? new Date(this.last).toISOString() : null, ...(limiter ? { limiter } : {}) };
  }
}

export const rateLimitMonitor = new RateLimitMonitor();
