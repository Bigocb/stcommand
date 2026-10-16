// World index: lookups over GameData. Pure; build once, share.
import type { GameData, MapTile, Layer, Item, Resource, Monster, Npc, NpcItemRow, TaskDef, Drop, EventDef } from './data.js';

export interface Pos { layer: Layer; x: number; y: number }

export interface WorldIndex {
  data: GameData;
  tileById: Map<number, MapTile>;
  tileAt(layer: Layer, x: number, y: number): MapTile | undefined;
  /** All tiles whose content matches. `code` omitted = every tile of that content type. */
  findContent(type: string, code?: string): MapTile[];
  items: Map<string, Item>;
  resources: Map<string, Resource>;
  monsters: Map<string, Monster>;
  npcs: Map<string, Npc>;
  npcItemsByItem: Map<string, NpcItemRow[]>;
  resourcesByDrop: Map<string, { resource: Resource; drop: Drop }[]>;
  monstersByDrop: Map<string, { monster: Monster; drop: Drop }[]>;
  tasksByReward: Map<string, TaskDef[]>;
  eventsByContent: Map<string, EventDef[]>;
  /** Nearest by tile distance on the same layer (cheap; ignores walls/transitions). Use route.ts for real cost. */
  nearestOfKind(from: Pos, type: string, code?: string): MapTile | undefined;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

export function buildWorldIndex(data: GameData): WorldIndex {
  const tileById = new Map<number, MapTile>();
  const grid = new Map<string, MapTile>();
  const byContent = new Map<string, MapTile[]>();
  for (const t of data.maps) {
    tileById.set(t.map_id, t);
    grid.set(`${t.layer}:${t.x}:${t.y}`, t);
    const c = t.interactions.content;
    if (c) { push(byContent, c.type, t); push(byContent, `${c.type}:${c.code}`, t); }
  }
  const items = new Map(data.items.map((i) => [i.code, i]));
  const resources = new Map(data.resources.map((r) => [r.code, r]));
  const monsters = new Map(data.monsters.map((m) => [m.code, m]));
  const npcs = new Map(data.npcs.map((n) => [n.code, n]));
  const npcItemsByItem = new Map<string, NpcItemRow[]>();
  for (const r of data.npcItems) push(npcItemsByItem, r.code, r);
  const resourcesByDrop = new Map<string, { resource: Resource; drop: Drop }[]>();
  for (const r of data.resources) for (const d of r.drops) push(resourcesByDrop, d.code, { resource: r, drop: d });
  const monstersByDrop = new Map<string, { monster: Monster; drop: Drop }[]>();
  for (const m of data.monsters) for (const d of m.drops) push(monstersByDrop, d.code, { monster: m, drop: d });
  const tasksByReward = new Map<string, TaskDef[]>();
  for (const t of data.tasks) for (const i of t.rewards.items ?? []) push(tasksByReward, i.code, t);
  const eventsByContent = new Map<string, EventDef[]>();
  for (const e of data.events) if (e.content) push(eventsByContent, `${e.content.type}:${e.content.code}`, e);

  return {
    data, tileById, items, resources, monsters, npcs, npcItemsByItem, resourcesByDrop, monstersByDrop, tasksByReward, eventsByContent,
    tileAt: (layer, x, y) => grid.get(`${layer}:${x}:${y}`),
    findContent: (type, code) => byContent.get(code === undefined ? type : `${type}:${code}`) ?? [],
    nearestOfKind(from, type, code) {
      let best: MapTile | undefined; let bd = Infinity;
      for (const t of byContent.get(code === undefined ? type : `${type}:${code}`) ?? []) {
        if (t.layer !== from.layer) continue;
        const d = Math.abs(t.x - from.x) + Math.abs(t.y - from.y);
        if (d < bd) { bd = d; best = t; }
      }
      return best;
    },
  };
}
