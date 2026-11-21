import { gzip } from "node:zlib";
import { promisify } from "node:util";

/**
 * GET /api/state, built once per fleet update instead of once per request (docs/memory-analysis-2026-11-21.md, item 1; clause
 * stateResponseSlim).
 *
 * Before: every poll from every open screen ran JSON.stringify over the whole snapshot, about 2,470 full SpaceTraders Ship objects,
 * then gzipped it. The heap sampler put 752 MB (66% of everything allocated) on that path. Now:
 *  - slimShip() drops the long `description` and `requirements` of the frame, reactor, engine, modules and mounts. Every field a
 *    screen reads stays: frame/reactor/engine symbol, name and condition; module symbol, name and capacity; mount symbol and name;
 *    crew, cargo, fuel, nav and cooldown unchanged.
 *  - StateBodyCache keeps one serialised body and its gzip per (tenant, variant) while the snapshot object is the same one and
 *    for at most `maxAgeMs`, so a screen polling every 5 s and another every 15 s share one stringify. Concurrent misses share one
 *    build.
 *
 * slimShip is pure. The cache keeps no decision state (it is a response cache, rebuilt on demand), so it may live in memory.
 */

const PART_DROP = ["description", "requirements"] as const;

function slimPart<T>(part: T): T {
  if (!part || typeof part !== "object") return part;
  const out = { ...(part as Record<string, unknown>) };
  for (const k of PART_DROP) delete out[k];
  return out as T;
}

/** A ship without the parts' description text and requirements. Nothing else changes. */
export function slimShip<S extends Record<string, unknown>>(ship: S): S {
  const out: Record<string, unknown> = { ...ship };
  for (const k of ["frame", "reactor", "engine"] as const) if (k in out) out[k] = slimPart(out[k]);
  for (const k of ["modules", "mounts"] as const) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(slimPart);
  return out as S;
}

const gzipAsync = promisify(gzip);

export interface StateBody {
  text: string;
  gzipped: Buffer;
  builtAt: number;
}

interface Entry {
  snapshot: object;
  builtAt: number;
  body: Promise<StateBody>;
}

export class StateBodyCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maxAgeMs = 10_000) {}

  /**
   * The body for `key` (tenant and variant): the cached one while `snapshot` is the same object and it is younger than maxAgeMs,
   * else `build()` serialised and gzipped once. A failed build is not kept.
   */
  get(key: string, snapshot: object, build: () => Promise<unknown>, now: number = Date.now()): Promise<StateBody> {
    const hit = this.entries.get(key);
    if (hit && hit.snapshot === snapshot && now - hit.builtAt < this.maxAgeMs) return hit.body;
    const body = (async (): Promise<StateBody> => {
      const text = JSON.stringify(await build());
      return { text, gzipped: await gzipAsync(text), builtAt: now };
    })();
    const entry: Entry = { snapshot, builtAt: now, body };
    this.entries.set(key, entry);
    body.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return body;
  }

  /** Entries held (tests, ops). */
  size(): number {
    return this.entries.size;
  }
}
