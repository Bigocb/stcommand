// XP, drops and gold math. Pure.

export type MonsterKind = 'normal' | 'elite' | 'boss' | 'raid_boss' | string;

export interface XpPolicy {
  /** Penalty by how far the PLAYER is above the monster. Sorted by minGap descending is applied. */
  penalties: { minGap: number; factor: number }[];
  mult: Record<string, number>;
}
/**
 * ASSUMPTION: the doc says "1.0 if monster level <= yours (no penalty)"; 0.7 at 5+ levels gap, 0 at 10+.
 * The penalty is read as player-level minus monster-level (farming far-weaker monsters is what gets
 * penalised). Gaps 1-4 = 1.0 (undocumented), 5-9 = 0.7.
 */
export const DEFAULT_XP_POLICY: XpPolicy = {
  penalties: [{ minGap: 10, factor: 0 }, { minGap: 5, factor: 0.7 }],
  mult: { normal: 1, elite: 1.4, boss: 2, raid_boss: 2 },
};

export function levelPenalty(playerLevel: number, monsterLevel: number, p: XpPolicy = DEFAULT_XP_POLICY): number {
  const gap = playerLevel - monsterLevel;
  for (const { minGap, factor } of [...p.penalties].sort((a, b) => b.minGap - a.minGap)) if (gap >= minGap) return factor;
  return 1;
}

/** Round half up. */
export const roundHalfUp = (x: number): number => Math.floor(x + 0.5 + 1e-9);

export function fightXp(
  a: { playerLevel: number; wisdom: number; monsterLevel: number; monsterHp: number; kind?: MonsterKind },
  p: XpPolicy = DEFAULT_XP_POLICY,
): number {
  const base = (a.monsterLevel / a.playerLevel) * 20 + a.monsterHp * 0.04;
  const mult = p.mult[a.kind ?? 'normal'] ?? 1;
  return roundHalfUp(base * levelPenalty(a.playerLevel, a.monsterLevel, p) * mult * (1 + a.wisdom * 0.001));
}

/** Drop chance: 1/rate, scaled by prospecting (1 point = +0.1%), capped at 1. */
export function dropChance(rate: number, prospecting: number): number {
  return Math.min(1, (1 / rate) * (1 + prospecting * 0.001));
}

export interface DropDef { code: string; rate: number; min_quantity: number; max_quantity: number }

/** Expected units of each drop per kill. */
export function expectedDrops(drops: readonly DropDef[], prospecting: number): { code: string; perKill: number }[] {
  return drops.map((d) => ({ code: d.code, perKill: dropChance(d.rate, prospecting) * ((d.min_quantity + d.max_quantity) / 2) }));
}

/** Expected gold per kill: mean of the gold range plus drops valued via `itemValue` (gold per unit; unknown = 0). */
export function expectedGold(
  m: { min_gold: number; max_gold: number; drops: readonly DropDef[] }, prospecting: number, itemValue: Readonly<Record<string, number>> = {},
): number {
  let g = (m.min_gold + m.max_gold) / 2;
  for (const d of expectedDrops(m.drops, prospecting)) g += d.perKill * (itemValue[d.code] ?? 0);
  return g;
}
