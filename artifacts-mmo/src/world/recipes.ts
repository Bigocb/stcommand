// craftTree: expand recipes down to raw gatherables / monster drops / npc purchases. Pure.
import type { WorldIndex } from './index.js';
import { whereToGet, expectedYield, type Source } from './sources.js';

export type TreeNode =
  | { kind: 'craft'; code: string; qty: number; skill: string; level: number; runs: number; children: TreeNode[] }
  | { kind: 'raw'; code: string; qty: number; best: Source | null }
  | { kind: 'cycle'; code: string; qty: number; path: string[] }
  | { kind: 'unknown'; code: string; qty: number };

export interface RawNeed {
  code: string; qty: number;
  /** All non-craft ways to get it. */
  sources: Source[];
  /** Chosen: fewest expected actions among resource/monster, else npc, else task/other. */
  best: Source | null;
  /** Expected gather/fight actions for the whole quantity (0 if bought from an npc). */
  actions: number;
  /** Currency cost when best is an npc purchase. */
  npcCost?: { currency: string; amount: number };
}
export interface CraftTree {
  root: TreeNode;
  raw: Record<string, RawNeed>;
  /** Highest level required per skill (crafting and gathering skills; `combat` = highest monster level to fight). */
  skillLevels: Record<string, number>;
  craftActions: number;
  gatherActions: number;
  totalActions: number;
  cycles: string[][];
  unknown: string[];
}

function chooseBest(srcs: Source[], qty: number): { best: Source | null; actions: number; npcCost?: RawNeed['npcCost'] } {
  let best: Source | null = null; let bestActions = Infinity;
  for (const s of srcs) {
    if (s.kind !== 'resource' && s.kind !== 'monster') continue;
    const a = Math.ceil(qty / expectedYield(s.rate, s.min, s.max));
    if (a < bestActions) { best = s; bestActions = a; }
  }
  if (best) return { best, actions: bestActions };
  const npc = srcs.find((s) => s.kind === 'npc');
  if (npc && npc.kind === 'npc') return { best: npc, actions: 0, npcCost: { currency: npc.currency, amount: npc.price * qty } };
  return { best: srcs[0] ?? null, actions: 0 };
}

export function craftTree(index: WorldIndex, itemCode: string, qty = 1): CraftTree {
  const raw: Record<string, RawNeed> = {};
  const skillLevels: Record<string, number> = {};
  const cycles: string[][] = [];
  const unknown = new Set<string>();
  let craftActions = 0;
  const need = (skill: string, lvl: number) => { skillLevels[skill] = Math.max(skillLevels[skill] ?? 0, lvl); };

  const expand = (code: string, q: number, stack: string[]): TreeNode => {
    const item = index.items.get(code);
    if (!item) { unknown.add(code); return { kind: 'unknown', code, qty: q }; }
    if (stack.includes(code)) {
      const path = [...stack.slice(stack.indexOf(code)), code];
      cycles.push(path);
      return { kind: 'cycle', code, qty: q, path };
    }
    if (item.craft) {
      const runs = Math.ceil(q / item.craft.quantity);
      craftActions += runs;
      need(item.craft.skill, item.craft.level);
      return {
        kind: 'craft', code, qty: q, skill: item.craft.skill, level: item.craft.level, runs,
        children: item.craft.items.map((ci) => expand(ci.code, ci.quantity * runs, [...stack, code])),
      };
    }
    const srcs = whereToGet(index, code).filter((s) => s.kind !== 'craft' && s.kind !== 'grand_exchange');
    const total = (raw[code]?.qty ?? 0) + q;
    const c = chooseBest(srcs, total);
    raw[code] = { code, qty: total, sources: srcs, best: c.best, actions: c.actions, ...(c.npcCost ? { npcCost: c.npcCost } : {}) };
    if (c.best?.kind === 'resource') need(c.best.skill, c.best.level);
    if (c.best?.kind === 'monster') need('combat', c.best.level);
    return { kind: 'raw', code, qty: q, best: c.best };
  };

  const root = expand(itemCode, qty, []);
  const gatherActions = Object.values(raw).reduce((n, r) => n + r.actions, 0);
  return { root, raw, skillLevels, craftActions, gatherActions, totalActions: craftActions + gatherActions, cycles, unknown: [...unknown] };
}
