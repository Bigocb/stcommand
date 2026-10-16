// Aggregate a character's combat stats from equipped items. Pure.

export const ELEMENTS = ['fire', 'earth', 'water', 'air'] as const;
export type Element = (typeof ELEMENTS)[number];
export type PerElement = Record<Element, number>;

export interface ItemEffect { code: string; value: number }
export interface ItemDef { code: string; level?: number; type?: string; effects: ItemEffect[] }

export interface CombatStats {
  level: number;
  maxHp: number;
  attack: PerElement; // base attack per element (before dmg bonuses)
  dmg: number; // global damage %
  dmgEl: PerElement; // per-element damage %
  res: PerElement; // resistance %
  critical: number; // crit chance %, 1 point = 1%
  haste: number;
  initiative: number;
  wisdom: number;
  prospecting: number;
}

/** Not documented by the API/docs page (only "+5 max HP per level" is), so it is policy. */
export interface BaseStatsPolicy {
  /** max HP of a level-1 character with no gear (ASSUMPTION: 120, community-known). */
  baseHpLevel1: number;
  /** documented: +5 max HP per level */
  hpPerLevel: number;
  /** ASSUMPTION: bare-character initiative (monsters in data/monsters.json use 50-ish values). */
  baseInitiative: number;
}
export const DEFAULT_BASE_POLICY: BaseStatsPolicy = { baseHpLevel1: 120, hpPerLevel: 5, baseInitiative: 100 };

export function maxHpForLevel(level: number, p: BaseStatsPolicy = DEFAULT_BASE_POLICY): number {
  return p.baseHpLevel1 + p.hpPerLevel * (level - 1);
}

const zero = (): PerElement => ({ fire: 0, earth: 0, water: 0, air: 0 });

export function aggregateStats(level: number, equipped: readonly ItemDef[], policy: BaseStatsPolicy = DEFAULT_BASE_POLICY): CombatStats {
  const s: CombatStats = {
    level, maxHp: maxHpForLevel(level, policy), attack: zero(), dmg: 0, dmgEl: zero(), res: zero(),
    critical: 0, haste: 0, initiative: policy.baseInitiative, wisdom: 0, prospecting: 0,
  };
  for (const item of equipped) {
    for (const { code, value } of item.effects) {
      if (code === 'hp') s.maxHp += value;
      else if (code === 'dmg') s.dmg += value;
      else if (code === 'critical_strike') s.critical += value;
      else if (code === 'haste') s.haste += value;
      else if (code === 'initiative') s.initiative += value;
      else if (code === 'wisdom') s.wisdom += value;
      else if (code === 'prospecting') s.prospecting += value;
      else {
        const m = /^(attack|dmg|res)_(fire|earth|water|air)$/.exec(code);
        if (!m) continue; // heal, teleport, tool skills, ... not combat stats
        const el = m[2] as Element;
        if (m[1] === 'attack') s.attack[el] += value;
        else if (m[1] === 'dmg') s.dmgEl[el] += value;
        else s.res[el] += value;
      }
    }
  }
  return s;
}
