// Typed records for data/*.json plus an injected-reader loader (no I/O here).

export type Layer = 'overworld' | 'underground' | 'interior';
export type AccessType = 'standard' | 'blocked' | 'conditional' | 'restricted';
export type ConditionOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'has_item' | 'cost' | 'achievement_unlocked';

export interface Condition { code: string; operator: ConditionOperator; value: number }
export interface Content { type: string; code: string }
export interface Transition { map_id: number; x: number; y: number; layer: Layer; conditions: Condition[] }
export interface MapTile {
  map_id: number; name: string; skin: string; x: number; y: number; layer: Layer;
  access: { type: AccessType; conditions: Condition[] };
  interactions: { content: Content | null; transition: Transition | null };
}
export interface Drop { code: string; rate: number; min_quantity: number; max_quantity: number }
export interface Craft { skill: string; level: number; items: { code: string; quantity: number }[]; quantity: number }
export interface Item {
  name: string; code: string; level: number; type: string; subtype: string; description: string;
  conditions: Condition[]; effects: { code: string; value: number; description?: string }[];
  craft: Craft | null; tradeable: boolean; recyclable?: boolean;
}
export interface Resource { name: string; code: string; skill: string; level: number; drops: Drop[] }
export interface Monster {
  name: string; code: string; level: number; type: string; hp: number;
  min_gold: number; max_gold: number; drops: Drop[];
  [k: string]: unknown;
}
export interface NpcItem { code: string; currency: string; buy_price: number | null; sell_price: number | null }
export interface Npc { name: string; code: string; description: string; type: string; items?: NpcItem[] }
export interface NpcItemRow { code: string; npc: string; currency: string; buy_price: number | null; sell_price: number | null }
export interface TaskDef {
  code: string; level: number; type: string; min_quantity: number; max_quantity: number;
  skill: string | null; rewards: { items: { code: string; quantity: number }[] | null; gold: number };
}
export interface EventDef {
  name: string; code: string; content: Content | null;
  maps: { map_id: number; x: number; y: number; layer: Layer }[];
  [k: string]: unknown;
}

export interface GameData {
  maps: MapTile[]; items: Item[]; resources: Resource[]; monsters: Monster[];
  npcs: Npc[]; npcItems: NpcItemRow[]; tasks: TaskDef[]; taskRewards: Drop[]; events: EventDef[];
}

/** `readJson('maps.json')` returns the parsed file. Inject fs in production, a stub in tests. */
export type JsonReader = (file: string) => unknown;

function arr<T>(v: unknown, file: string): T[] {
  if (!Array.isArray(v)) throw new Error(`${file}: expected a JSON array`);
  return v as T[];
}

export function loadGameData(readJson: JsonReader): GameData {
  const opt = <T>(file: string): T[] => {
    try { return arr<T>(readJson(file), file); } catch { return []; }
  };
  const maps = arr<MapTile>(readJson('maps.json'), 'maps.json');
  for (const m of maps) {
    m.access.conditions ??= [];
    if (m.interactions.transition) m.interactions.transition.conditions ??= [];
  }
  return {
    maps,
    items: arr<Item>(readJson('items.json'), 'items.json'),
    resources: arr<Resource>(readJson('resources.json'), 'resources.json'),
    monsters: arr<Monster>(readJson('monsters.json'), 'monsters.json'),
    npcs: arr<Npc>(readJson('npcs.json'), 'npcs.json'),
    npcItems: arr<NpcItemRow>(readJson('npc_items.json'), 'npc_items.json'),
    tasks: opt<TaskDef>('tasks.json'),
    taskRewards: opt<Drop>('task_rewards.json'),
    events: opt<EventDef>('events.json'),
  };
}
