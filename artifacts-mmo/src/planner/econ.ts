// Pure economics helpers: amortising a banking round trip over the actions that fill the bag.
import type { InvItem, PlannerPolicy, SkillState } from './types.js';
import { levelPenalty } from '../sim/xp.js';

export interface AmortiseIn {
  actionSeconds: number; // cooldown of one action (rest included by the caller if wanted)
  itemsPerAction: number; // expected items added to the bag per action
  capacityItems: number; // items to collect before banking (inventoryMax * bankAtFraction)
  roundTripSeconds: number; // work site -> bank -> work site travel
  depositSeconds: number;
  maxActions: number;
}
export interface Amortised { actionsPerTrip: number; effSecondsPerAction: number; tripOverheadSeconds: number }

/** effective seconds per action = action + (round trip + deposit) / actions needed to fill the bag. */
export function amortise(a: AmortiseIn): Amortised {
  const fill = a.itemsPerAction > 1e-9 ? a.capacityItems / a.itemsPerAction : Infinity;
  const actionsPerTrip = Math.max(1, Math.min(a.maxActions, fill));
  const overhead = a.roundTripSeconds + a.depositSeconds;
  return { actionsPerTrip, effSecondsPerAction: a.actionSeconds + overhead / actionsPerTrip, tripOverheadSeconds: overhead };
}

export const used = (inv: readonly InvItem[]): number => inv.reduce((n, i) => n + i.quantity, 0);
export const invMap = (inv: readonly InvItem[]): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const i of inv) m[i.code] = (m[i.code] ?? 0) + i.quantity;
  return m;
};

export const xpToNext = (level: number, p: PlannerPolicy): number => p.xpToNextBase + p.xpToNextPerLevel * (level - 1);
export const skillMaxXp = (s: SkillState, p: PlannerPolicy): number => s.maxXp ?? xpToNext(s.level, p);
/** ASSUMPTION: gather xp per action grows linearly with resource level; same level-gap penalty as combat. */
export const gatherXp = (resLevel: number, skillLevel: number, p: PlannerPolicy): number =>
  Math.round((p.gatherXpBase + p.gatherXpPerLevel * resLevel) * levelPenalty(skillLevel, resLevel));
export const craftXp = (itemLevel: number, skillLevel: number, p: PlannerPolicy): number =>
  Math.round((p.craftXpBase + p.craftXpPerLevel * itemLevel) * levelPenalty(skillLevel, itemLevel));
