/**
 * Routes the fleet has found dead, shared between ships.
 *
 * A trader that reaches a buy market and finds the live price no longer pays (the dispatcher planned on a snapshot) puts
 * the route on its own private dead list, in trader.ts. The dispatcher knows nothing about it, so the next ship is
 * handed the same route, flies there and finds it dead again. 2026-10-24: 88 such rejections in about 55 minutes across
 * seven ships, the same few markets over and over (EQUIPMENT at X1-KG7-DD5E, SHIP_PARTS at X1-KG7-AA8B, SHIP_PLATING at
 * X1-KG7-D16E), and THEOREM-151 bounced off three of them in a quarter of an hour.
 *
 * Here a ship reports what it found and the dispatcher keeps the route out of everyone's list until the block lapses.
 * Two kinds of key: `good@buyAt` when the buy price itself moved (every destination is affected), and
 * `good@buyAt>sellAt` when only one destination's bid refused the trip.
 *
 * Pure apart from the map it owns: the caller passes the time. `ttlMin` 0 (the default policy) records and blocks nothing,
 * so the dispatcher behaves exactly as before.
 *
 * Kept across a restart: `toJson()` / `restore()` round-trip the standing blocks (absolute end times, so a block that
 * would have lapsed while the process was down is simply not restored). The fleet saves them with the other dispatch
 * state (fleet flag `deadRoutes`), because every deploy restarts the service and a list that forgot itself each time
 * would have each ship learn the same dead routes again.
 */

export interface BlockPolicy {
  /** Minutes a reported route stays out of the list; 0 = off. */
  ttlMin: number;
}

export const DEFAULT_BLOCK_POLICY: BlockPolicy = { ttlMin: 0 };

export const buyKey = (good: string, buyAt: string): string => `${good}@${buyAt}`;
export const legKey = (good: string, buyAt: string, sellAt: string): string => `${good}@${buyAt}>${sellAt}`;

interface Block {
  until: number;
  reason: string;
  /** How many reports have refreshed it. */
  reports: number;
}

export class RouteBlocks {
  private readonly blocks = new Map<string, Block>();

  /** A ship found this route dead. `sellAt` undefined blocks the buy market for every destination. */
  report(good: string, buyAt: string, sellAt: string | undefined, reason: string, now: number, policy: BlockPolicy): void {
    if (!(policy.ttlMin > 0)) return;
    const key = sellAt === undefined ? buyKey(good, buyAt) : legKey(good, buyAt, sellAt);
    const prev = this.blocks.get(key);
    this.blocks.set(key, { until: now + policy.ttlMin * 60_000, reason, reports: (prev && prev.until > now ? prev.reports : 0) + 1 });
  }

  /** Why this route is out of the list, or undefined when it is free to take. */
  reasonFor(route: { good: string; buyAt: string; sellAt: string }, now: number): string | undefined {
    for (const key of [buyKey(route.good, route.buyAt), legKey(route.good, route.buyAt, route.sellAt)]) {
      const b = this.blocks.get(key);
      if (b && b.until > now) return `${b.reason} (reported dead, ${Math.ceil((b.until - now) / 60_000)} min left)`;
    }
    return undefined;
  }

  /** Forget lapsed blocks; returns how many are still standing. */
  prune(now: number): number {
    for (const [k, b] of this.blocks) if (b.until <= now) this.blocks.delete(k);
    return this.blocks.size;
  }

  /** The standing blocks as JSON (lapsed ones left out), in a stable order so an unchanged list saves nothing. */
  toJson(now: number): string {
    const rows = [...this.blocks.entries()].filter(([, b]) => b.until > now).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(rows.map(([key, b]) => [key, b.until, b.reason, b.reports]));
  }

  /** Load blocks saved by toJson(). Malformed input and lapsed blocks are skipped; never throws. */
  restore(json: string, now: number): number {
    let rows: unknown;
    try { rows = JSON.parse(json); } catch { return 0; }
    if (!Array.isArray(rows)) return 0;
    let loaded = 0;
    for (const r of rows) {
      if (!Array.isArray(r)) continue;
      const [key, until, reason, reports] = r as [unknown, unknown, unknown, unknown];
      if (typeof key !== "string" || typeof until !== "number" || !Number.isFinite(until) || until <= now) continue;
      this.blocks.set(key, { until, reason: typeof reason === "string" ? reason : "reported dead", reports: typeof reports === "number" && reports > 0 ? Math.floor(reports) : 1 });
      loaded++;
    }
    return loaded;
  }

  /** The blocks standing now, for the ops view. */
  list(now: number): { key: string; reason: string; minutesLeft: number; reports: number }[] {
    return [...this.blocks.entries()]
      .filter(([, b]) => b.until > now)
      .map(([key, b]) => ({ key, reason: b.reason, minutesLeft: Math.ceil((b.until - now) / 60_000), reports: b.reports }));
  }
}
