// Shared helpers for the decision modules.
import type { CharacterContext } from '../world/route.js';
import { planRouteToAny } from '../world/route.js';
import type { MapTile } from '../world/data.js';
import type { Pos } from '../world/index.js';
import { invMap } from './econ.js';
import type { CharState, PlanStep, PlannerPolicy, World, ActionKind, Expect } from './types.js';

export type Memo = Map<string, unknown>;

export function memoise<T>(memo: Memo, key: string, f: () => T): T {
  if (memo.has(key)) return memo.get(key) as T;
  const v = f(); memo.set(key, v); return v;
}

export const posOf = (t: MapTile): Pos => ({ layer: t.layer, x: t.x, y: t.y });
export const samePos = (a: Pos, b: Pos): boolean => a.layer === b.layer && a.x === b.x && a.y === b.y;

export function routeCtx(s: CharState): CharacterContext {
  const attributes: Record<string, number> = { level: s.level };
  for (const [k, v] of Object.entries(s.skills)) attributes[`${k}_level`] = v.level;
  return { items: invMap(s.inventory), gold: s.gold, attributes };
}

/** Gold per item: best npc sell price in gold, overridden by policy. */
export function itemValues(world: World, p: PlannerPolicy, memo: Memo): Record<string, number> {
  return memoise(memo, 'itemValue', () => {
    const v: Record<string, number> = {};
    for (const r of world.data.npcItems) if (r.currency === 'gold' && r.sell_price) v[r.code] = Math.max(v[r.code] ?? 0, r.sell_price);
    return { ...v, ...p.itemValue };
  });
}

/** Seconds from a tile to the nearest bank (null: no bank reachable). Cached per tile. */
export function bankSeconds(world: World, from: MapTile, ctx: CharacterContext, memo: Memo): number | null {
  return memoise(memo, `bank|${from.map_id}`, () => {
    const banks = world.findContent('bank');
    if (!banks.length) return null;
    const r = planRouteToAny(world, from.map_id, banks, ctx);
    return r.ok ? r.seconds : null;
  });
}

/** Round trip to the bank from the cheapest of `tiles` (0 when no bank is reachable, so the trip is free). */
export function bestBankRound(world: World, tiles: MapTile[], ctx: CharacterContext, memo: Memo): { seconds: number; reachable: boolean } {
  let best = Infinity;
  for (const t of tiles) { const s = bankSeconds(world, t, ctx, memo); if (s !== null && s < best) best = s; }
  return best === Infinity ? { seconds: 0, reachable: false } : { seconds: 2 * best, reachable: true };
}

export const step = (action: ActionKind, args: Record<string, unknown>, cd: number, note: string): PlanStep => ({ action, args, expectedCooldownSeconds: cd, note });

/** A concrete next piece of work: go to one of `tiles` and do `action` there. */
export interface Visit {
  tiles: MapTile[];
  action: ActionKind; args: Record<string, unknown>; cooldown: number; expect: Expect;
  reason: string;
  keep: string[]; // item codes banking must not deposit
  fights: boolean; // rest first when hp is low
  tail?: PlanStep[]; // steps that follow this one
}
