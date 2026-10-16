// planHorizon / projectProgress: roll a state forward with expected values only (deterministic).
import { decideNext } from './decide.js';
import { pickTaskFor } from './decide.js';
import { DEFAULT_PLANNER_POLICY } from './policy.js';
import { itemValues, type Memo } from './common.js';
import { skillMaxXp, xpToNext } from './econ.js';
import type { ActionKind, CharState, Decision, InvItem, PlannerPolicy, World } from './types.js';

export const IDLE_SECONDS = 60; // what an idle decision costs the projection

export interface Gained { xp: Record<string, number>; gold: number; banked: InvItem[]; levels: Record<string, number> }

const addItem = (inv: InvItem[], code: string, q: number): InvItem[] => {
  const out = inv.map((i) => ({ ...i }));
  const f = out.find((i) => i.code === code);
  if (f) f.quantity += q; else out.push({ code, quantity: q });
  return out.filter((i) => i.quantity > 1e-9);
};

/** Apply one decision's expected effect. Returns the new state and what it gained. */
export function applyDecision(s: CharState, d: Decision, world: World, p: PlannerPolicy, memo: Memo = new Map()): { state: CharState; gained: Gained } {
  const start = Math.max(s.now, s.cooldownReadyAt);
  const end = start + (d.action === 'idle' ? IDLE_SECONDS : d.expectedCooldownSeconds);
  const n: CharState = { ...s, skills: { ...s.skills }, inventory: s.inventory.map((i) => ({ ...i })), now: end, cooldownReadyAt: end };
  const g: Gained = { xp: {}, gold: 0, banked: [], levels: {} };
  const e = d.expect;
  if (e.moveTo) n.position = { ...e.moveTo };
  if (e.hpRestored) n.hp = Math.min(n.maxHp, n.hp + e.hpRestored);
  if (e.hpLost) n.hp = Math.max(1, n.hp - e.hpLost);
  if (e.gold) { n.gold += e.gold; g.gold += e.gold; }
  for (const c of e.consumes ?? []) n.inventory = addItem(n.inventory, c.code, -c.quantity);
  for (const i of e.items ?? []) n.inventory = addItem(n.inventory, i.code, i.quantity);
  if (e.xp && e.skill) {
    g.xp[e.skill] = e.xp;
    if (e.skill === 'combat') {
      let xp = (n.xp ?? 0) + e.xp, max = n.maxXp ?? xpToNext(n.level, p);
      while (xp >= max) { xp -= max; n.level++; n.maxHp += p.hpPerLevel; n.hp += p.hpPerLevel; max = xpToNext(n.level, p); g.levels.combat = (g.levels.combat ?? 0) + 1; }
      n.xp = xp; n.maxXp = max;
    } else {
      const cur = n.skills[e.skill] ?? { level: 1, xp: 0 };
      let lv = cur.level, xp = cur.xp + e.xp, max = skillMaxXp(cur, p);
      while (xp >= max) { xp -= max; lv++; max = xpToNext(lv, p); g.levels[e.skill] = (g.levels[e.skill] ?? 0) + 1; }
      n.skills[e.skill] = { level: lv, xp, maxXp: max };
    }
  }
  if (e.bank) {
    const keep = new Set(e.keep ?? []);
    g.banked = n.inventory.filter((i) => !keep.has(i.code));
    n.inventory = n.inventory.filter((i) => keep.has(i.code));
  }
  if (d.action === 'task_new') { const t = pickTaskFor(s, world, p, memo); n.task = t ? { ...t.task } : null; }
  if (e.taskProgress && n.task) n.task = { ...n.task, progress: n.task.progress + e.taskProgress };
  if (e.taskDone) n.task = null;
  return { state: n, gained: g };
}

export interface HorizonStep { index: number; startsAt: number; decision: Decision; after: CharState }

/** Roll `n` decisions forward. Expected values only; quantities may be fractional. */
export function planHorizon(state: CharState, world: World, policy: PlannerPolicy = DEFAULT_PLANNER_POLICY, n: number, memo: Memo = new Map()): HorizonStep[] {
  const out: HorizonStep[] = [];
  let s = state;
  for (let i = 0; i < n; i++) {
    const d = decideNext(s, world, policy, memo);
    const startsAt = Math.max(s.now, s.cooldownReadyAt);
    s = applyDecision(s, d, world, policy, memo).state;
    out.push({ index: i, startsAt, decision: d, after: s });
  }
  return out;
}

export interface Projection {
  elapsedSeconds: number; decisions: number;
  xpBySkill: Record<string, number>; xpPerHour: number; xpPerHourBySkill: Record<string, number>;
  /** coin drops + task rewards */
  goldGained: number; goldPerHour: number;
  /** npc-sell value of items banked or still in the bag */
  itemValue: number; itemValuePerHour: number;
  levelsGained: Record<string, number>;
  secondsByAction: Partial<Record<ActionKind, number>>; countByAction: Partial<Record<ActionKind, number>>;
  end: CharState;
}

/** Simulate `seconds` of play (default one hour) and report per-hour rates. */
export function projectProgress(state: CharState, world: World, policy: PlannerPolicy = DEFAULT_PLANNER_POLICY, seconds = 3600, memo: Memo = new Map(), maxDecisions = 20000): Projection {
  const t0 = Math.max(state.now, state.cooldownReadyAt);
  const xp: Record<string, number> = {}, levels: Record<string, number> = {};
  const secs: Partial<Record<ActionKind, number>> = {}, cnt: Partial<Record<ActionKind, number>> = {};
  const banked: Record<string, number> = {};
  let gold = 0, s = state, k = 0;
  while (Math.max(s.now, s.cooldownReadyAt) < t0 + seconds && k < maxDecisions) {
    const d = decideNext(s, world, policy, memo);
    const r = applyDecision(s, d, world, policy, memo);
    const dt = r.state.now - Math.max(s.now, s.cooldownReadyAt);
    secs[d.action] = (secs[d.action] ?? 0) + dt; cnt[d.action] = (cnt[d.action] ?? 0) + 1;
    for (const [sk, v] of Object.entries(r.gained.xp)) xp[sk] = (xp[sk] ?? 0) + v;
    for (const [sk, v] of Object.entries(r.gained.levels)) levels[sk] = (levels[sk] ?? 0) + v;
    for (const b of r.gained.banked) banked[b.code] = (banked[b.code] ?? 0) + b.quantity;
    gold += r.gained.gold; s = r.state; k++;
  }
  const elapsed = Math.max(1, Math.max(s.now, s.cooldownReadyAt) - t0), hours = elapsed / 3600;
  const iv = itemValues(world, policy, memo);
  for (const i of s.inventory) banked[i.code] = (banked[i.code] ?? 0) + i.quantity;
  const itemValue = Object.entries(banked).reduce((n, [c, q]) => n + q * (iv[c] ?? 0), 0);
  const totalXp = Object.values(xp).reduce((a, b) => a + b, 0);
  return {
    elapsedSeconds: elapsed, decisions: k, xpBySkill: xp, xpPerHour: totalXp / hours,
    xpPerHourBySkill: Object.fromEntries(Object.entries(xp).map(([a, b]) => [a, b / hours])),
    goldGained: gold, goldPerHour: gold / hours, itemValue, itemValuePerHour: itemValue / hours,
    levelsGained: levels, secondsByAction: secs, countByAction: cnt, end: s,
  };
}
