// whereToGet: every way to obtain an item. Pure.
import type { WorldIndex } from './index.js';
import type { Craft, MapTile } from './data.js';

export type Source =
  | { kind: 'craft'; craft: Craft; workshop: string; tiles: MapTile[] }
  | { kind: 'resource'; resource: string; skill: string; level: number; rate: number; min: number; max: number; tiles: MapTile[] }
  | { kind: 'monster'; monster: string; level: number; rate: number; min: number; max: number; tiles: MapTile[] }
  | { kind: 'npc'; npc: string; currency: string; price: number; tiles: MapTile[] }
  | { kind: 'task'; task: string; taskType: string; quantity: number }
  | { kind: 'task_reward_pool'; rate: number; min: number; max: number }
  | { kind: 'grand_exchange'; note: string };

/** Expected items per action for a drop that fires with probability 1/rate. */
export const expectedYield = (rate: number, min: number, max: number): number => ((min + max) / 2) / Math.max(1, rate);

export function whereToGet(index: WorldIndex, itemCode: string): Source[] {
  const out: Source[] = [];
  const item = index.items.get(itemCode);
  if (item?.craft) out.push({ kind: 'craft', craft: item.craft, workshop: item.craft.skill, tiles: index.findContent('workshop', item.craft.skill) });
  for (const { resource, drop } of index.resourcesByDrop.get(itemCode) ?? [])
    out.push({ kind: 'resource', resource: resource.code, skill: resource.skill, level: resource.level, rate: drop.rate, min: drop.min_quantity, max: drop.max_quantity, tiles: index.findContent('resource', resource.code) });
  for (const { monster, drop } of index.monstersByDrop.get(itemCode) ?? [])
    out.push({ kind: 'monster', monster: monster.code, level: monster.level, rate: drop.rate, min: drop.min_quantity, max: drop.max_quantity, tiles: index.findContent('monster', monster.code) });
  for (const r of index.npcItemsByItem.get(itemCode) ?? [])
    if (r.buy_price !== null) out.push({ kind: 'npc', npc: r.npc, currency: r.currency, price: r.buy_price, tiles: index.findContent('npc', r.npc) });
  for (const t of index.tasksByReward.get(itemCode) ?? [])
    out.push({ kind: 'task', task: t.code, taskType: t.type, quantity: t.rewards.items?.find((i) => i.code === itemCode)?.quantity ?? 0 });
  for (const d of index.data.taskRewards) if (d.code === itemCode) out.push({ kind: 'task_reward_pool', rate: d.rate, min: d.min_quantity, max: d.max_quantity });
  if (item?.tradeable && index.findContent('grand_exchange').length) out.push({ kind: 'grand_exchange', note: 'buy from other players if listed' });
  return out;
}
