/**
 * What each dashboard endpoint costs the box (issue #87): requests, the JSON built (bytes before gzip), the bytes sent, and the
 * time from request to the last byte, per route over a rolling window. Read with ops http_endpoints.
 *
 * Why: on 2026-11-27 a CPU profile put about 10% of the process in JSON.stringify of large bodies and the phone kept reloading
 * Tower, but nothing said which endpoint built them or how often. This answers that.
 *
 * The store is pure (the clock comes in); the Express middleware below fills it. In memory on purpose: a restart empties it and
 * `coveredMin` says how much of the window it holds. Nothing decides from it.
 */
import type { NextFunction, Request, Response } from "express";

export interface EndpointHit { at: number; route: string; jsonBytes: number; sentBytes: number; ms: number; status: number; cached?: boolean }

export interface EndpointRow {
  route: string;
  calls: number;
  perMin: number;
  avgMs: number;
  maxMs: number;
  /** JSON.stringify output, before gzip: what the box serialized and what the browser parses. */
  avgJsonKB: number;
  maxJsonKB: number;
  totalJsonMB: number;
  /** On the wire. */
  totalSentMB: number;
  /** Answered from the server cache (src/http/cache.ts keyedTtlCache). */
  cachedShare: number;
  errors: number;
}

export class EndpointStats {
  private hits: EndpointHit[] = [];
  private started: number;
  constructor(private readonly keepMs = 24 * 3600_000, private readonly maxHits = 200_000, now = Date.now()) { this.started = now; }

  record(h: EndpointHit): void {
    this.hits.push(h);
    if (this.hits.length > this.maxHits) this.hits.splice(0, this.hits.length - this.maxHits);
    const cut = h.at - this.keepMs;
    if (this.hits.length && this.hits[0]!.at < cut) {
      let i = 0;
      while (i < this.hits.length && this.hits[i]!.at < cut) i++;
      this.hits.splice(0, i);
    }
  }

  summary(now: number, windowMs: number, top = 25): { windowMin: number; coveredMin: number; calls: number; totalJsonMB: number; endpoints: EndpointRow[] } {
    const from = now - windowMs;
    const span = Math.max(60_000, Math.min(windowMs, now - Math.max(this.started, this.hits[0]?.at ?? now))) / 60_000;
    const by = new Map<string, EndpointHit[]>();
    for (const h of this.hits) if (h.at >= from) (by.get(h.route) ?? by.set(h.route, []).get(h.route)!).push(h);
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const rows: EndpointRow[] = [...by.entries()].map(([route, hs]) => {
      const json = hs.reduce((s, h) => s + h.jsonBytes, 0);
      return {
        route, calls: hs.length, perMin: r1(hs.length / span),
        avgMs: Math.round(hs.reduce((s, h) => s + h.ms, 0) / hs.length), maxMs: Math.round(Math.max(...hs.map((h) => h.ms))),
        avgJsonKB: r1(json / hs.length / 1024), maxJsonKB: r1(Math.max(...hs.map((h) => h.jsonBytes)) / 1024),
        totalJsonMB: r2(json / 1048576), totalSentMB: r2(hs.reduce((s, h) => s + h.sentBytes, 0) / 1048576),
        cachedShare: Math.round((hs.filter((h) => h.cached).length / hs.length) * 100) / 100,
        errors: hs.filter((h) => h.status >= 500).length,
      };
    });
    rows.sort((a, b) => b.totalJsonMB - a.totalJsonMB || b.calls - a.calls);
    return { windowMin: Math.round(windowMs / 60_000), coveredMin: Math.round(span), calls: rows.reduce((s, r) => s + r.calls, 0), totalJsonMB: r2(rows.reduce((s, r) => s + r.totalJsonMB, 0)), endpoints: rows.slice(0, top) };
  }
}

export const endpointStats = new EndpointStats();

/** Route key: the path without its query, with system/waypoint symbols, ship symbols and long ids folded (Express's own
 *  req.baseUrl is unwound by the time `finish` fires, so the matched pattern is not reliable there). */
export function routeKey(req: { method: string; originalUrl: string }): string {
  const path = req.originalUrl.split("?")[0]!
    .replace(/\/X1-[A-Z0-9-]+/g, "/:sym")
    .replace(/\/[A-Z][A-Z0-9_]*-[0-9A-F]{1,4}(?=\/|$)/g, "/:ship")
    .replace(/\/[0-9a-f-]{16,}/gi, "/:id");
  return `${req.method} ${path}`;
}

/** Mark the response as answered from a server cache, for `cachedShare`. */
export const markCached = (res: Response): void => { res.locals.servedFromCache = true; };

/** Mount before gzipJson so its res.json wrapper (which records jsonBytes in res.locals) runs inside this one's timing. */
export function endpointStatsMiddleware(stats: EndpointStats = endpointStats) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.originalUrl.startsWith("/api/")) return next();
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const sent = Number(res.getHeader("Content-Length") ?? 0) || 0;
      stats.record({ at: Date.now(), route: routeKey(req), jsonBytes: Number(res.locals.jsonBytes ?? sent) || 0, sentBytes: sent, ms, status: res.statusCode, cached: !!res.locals.servedFromCache });
    });
    next();
  };
}
