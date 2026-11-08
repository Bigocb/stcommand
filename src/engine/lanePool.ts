import { laneProxyFromEnv } from "./apiLanes.js";

/**
 * A pool of proxy lanes (docs/api-lanes-pool-plan.md, phase 1: failover and a bytes counter).
 *
 * apiLanes.ts decides WHICH CLASS of call may leave from a proxy (read-only GETs at priority 3-4); this module decides WHICH proxy.
 * A call's key (the system it concerns, else the ship) maps to a preferred proxy by rendezvous hashing, so one system's reads keep
 * leaving from one IP while the pool is unchanged, and adding or removing a proxy moves only about 1/N of the keys. If the preferred
 * proxy's breaker is open, the next proxy in that key's own order is used; only when every active proxy is out does the caller fall
 * back to the box's IP (today's behaviour for one failed proxy).
 *
 * Pure: no I/O, no clock (callers pass `now`), no globals. With one proxy, `pickProxy` returns that proxy whenever its breaker allows,
 * exactly what the single lane did before.
 *
 * Config: API_LANE_PROXY_URLS, comma or whitespace separated, each `http://user:pass@host:port` with an optional `|rate` suffix
 * (requests a second, clamped as for the single lane). API_LANE_PROXY_URL alone keeps working as a pool of one. Ids are p1..pN in
 * the order written; the doctrine clause apiLaneCount says how many of the first ones are active (the rest are spares).
 */

export interface PoolProxy {
  id: string;
  url: string;
  /** host:port without credentials, for logs and tools. */
  label: string;
  ratePerSec: number;
}

export const MAX_POOL = 20;

/** The configured proxies, in order. Invalid or repeated entries are skipped (so a typo costs one proxy, not the pool). */
export function poolFromEnv(env: Record<string, string | undefined>, defaultRate: number): PoolProxy[] {
  const tokens = (env.API_LANE_PROXY_URLS ?? "").split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const out: PoolProxy[] = [];
  const seen = new Set<string>();
  const add = (url: string, rate: string | undefined): void => {
    if (out.length >= MAX_POOL) return;
    const cfg = laneProxyFromEnv({ API_LANE_PROXY_URL: url, API_LANE_PROXY_RATE: rate ?? env.API_LANE_PROXY_RATE }, defaultRate);
    if (!cfg || seen.has(cfg.url)) return;
    seen.add(cfg.url);
    out.push({ id: `p${out.length + 1}`, url: cfg.url, label: cfg.label, ratePerSec: cfg.ratePerSec });
  };
  for (const t of tokens) {
    const bar = t.indexOf("|");
    add(bar < 0 ? t : t.slice(0, bar), bar < 0 ? undefined : t.slice(bar + 1));
  }
  if (out.length === 0 && env.API_LANE_PROXY_URL?.trim()) add(env.API_LANE_PROXY_URL.trim(), undefined);
  return out;
}

function mix(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return mix(h);
}

/** The ids in this key's own order of preference (highest hash first). Stable for a given key and set of ids. */
export function rendezvousOrder(key: string, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => hash32(`${key}|${b}`) - hash32(`${key}|${a}`) || (a < b ? -1 : a > b ? 1 : 0));
}

export interface ProxyPick {
  id: string;
  /** One line for logs: which proxy and why not the first choice, if it was not. */
  reason: string;
}

/** The first proxy in the key's order whose breaker allows a request; undefined when every one is out. */
export function pickProxy(key: string, ids: readonly string[], allows: (id: string) => boolean): ProxyPick | undefined {
  const order = rendezvousOrder(key, ids);
  for (let i = 0; i < order.length; i++) {
    if (allows(order[i]!)) {
      return { id: order[i]!, reason: i === 0 ? `preferred for ${key}` : `${i} proxy(ies) ahead of it for ${key} are out` };
    }
  }
  return undefined;
}

/** What a call is about, for sharding: its system if the path names one, else its ship, else the path's first segments. */
export function laneKeyOf(path: string): string {
  const sys = /\/systems\/([^/?]+)/.exec(path);
  if (sys) return sys[1]!;
  const ship = /\/my\/ships\/([^/?]+)/.exec(path);
  if (ship) return ship[1]!;
  return path.split("?")[0]!.split("/").slice(0, 3).join("/") || "/";
}

const MINUTE = 60_000;
const KEEP_MINUTES = 60;

export interface ByteStats {
  /** Minutes of data behind the figures (the meter starts empty after a restart). */
  coveredMin: number;
  bytesPerMin: number;
  /** bytesPerMin carried out to a 30-day month, in GB (1e9 bytes). */
  projectedGBPerMonth: number;
  byKind: { kind: string; calls: number; avgBytes: number }[];
}

/**
 * Response bytes moved through one lane, by minute and by call kind. The proxy plan is billed in bytes, so the real figure replaces
 * the guess (5-10 KB a call) in the plan before any decision depends on it. Counts what the game returned; request bytes are small.
 */
export class ByteMeter {
  private readonly minutes = new Map<number, number>();
  private readonly kinds = new Map<string, { calls: number; bytes: number }>();
  private firstAt: number | undefined;

  record(at: number, kind: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    if (this.firstAt === undefined) this.firstAt = at;
    const m = Math.floor(at / MINUTE);
    this.minutes.set(m, (this.minutes.get(m) ?? 0) + bytes);
    if (this.minutes.size > KEEP_MINUTES * 2) {
      for (const k of [...this.minutes.keys()]) if (k < m - KEEP_MINUTES) this.minutes.delete(k);
    }
    const k = this.kinds.get(kind) ?? { calls: 0, bytes: 0 };
    k.calls += 1; k.bytes += bytes;
    this.kinds.set(kind, k);
  }

  stats(now: number, windowMin = 30): ByteStats {
    const nowMin = Math.floor(now / MINUTE);
    let bytes = 0;
    for (const [m, b] of this.minutes) if (m > nowMin - windowMin && m <= nowMin) bytes += b;
    const covered = this.firstAt === undefined ? 0 : Math.min(windowMin, Math.max(1, (now - this.firstAt) / MINUTE));
    const perMin = covered > 0 ? bytes / covered : 0;
    return {
      coveredMin: Math.round(covered * 10) / 10,
      bytesPerMin: Math.round(perMin),
      projectedGBPerMonth: Math.round(((perMin * 60 * 24 * 30) / 1e9) * 10) / 10,
      byKind: [...this.kinds.entries()]
        .map(([kind, v]) => ({ kind, calls: v.calls, avgBytes: Math.round(v.bytes / v.calls) }))
        .sort((a, b) => b.calls - a.calls),
    };
  }
}
