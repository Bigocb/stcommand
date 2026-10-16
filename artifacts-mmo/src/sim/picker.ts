// Rank monsters for a character by expected xp/hour and gold/hour (travel excluded; caller adds it).
import type { MonsterDef } from './fight.js';
import { monteCarlo, type MonteCarloResult } from './monteCarlo.js';
import { aggregateStats, DEFAULT_BASE_POLICY, type BaseStatsPolicy, type ItemDef } from './stats.js';
import { DEFAULT_XP_POLICY, expectedGold, fightXp, type XpPolicy } from './xp.js';

export interface PickerPolicy {
  winRateFloor: number; // default 0.95
  fights: number; // Monte Carlo samples per monster
  seed: number;
  rankBy: 'xp' | 'gold' | 'combined';
  /** combined = xp + goldWeight*gold */
  goldWeight: number;
  /** monster kinds a solo character may farm; bosses need groups */
  allowedTypes: string[];
  /** gold per unit for drops (e.g. from npc_items sell_price); unknown = 0 */
  itemValue: Record<string, number>;
  base: BaseStatsPolicy;
  xp: XpPolicy;
}
export const DEFAULT_PICKER_POLICY: PickerPolicy = {
  winRateFloor: 0.95, fights: 200, seed: 1, rankBy: 'xp', goldWeight: 1, allowedTypes: ['normal', 'elite'],
  itemValue: {}, base: DEFAULT_BASE_POLICY, xp: DEFAULT_XP_POLICY,
};

/** `equipped` = item codes, resolved against the `items` catalogue (unknown codes ignored). */
export interface PickerChar { level: number; equipped: readonly string[] }

export interface Candidate {
  code: string; level: number; eligible: boolean;
  winRate: number; avgTurns: number; avgHpLostPct: number;
  secondsPerFight: number; // cooldown + rest, travel excluded
  xpPerFight: number; xpPerHour: number; goldPerHour: number;
  reason: string;
  sim: MonteCarloResult;
}

export function evaluateMonsters(char: PickerChar, monsters: readonly MonsterDef[], items: ItemCatalogue, policy: Partial<PickerPolicy> = {}): Candidate[] {
  const p = { ...DEFAULT_PICKER_POLICY, ...policy };
  const stats = aggregateStats(char.level, resolve(char.equipped, items), p.base);
  const out: Candidate[] = [];
  for (const m of monsters) {
    const kind = m.type ?? 'normal';
    const sim = monteCarlo(stats, m, p.fights, p.seed);
    const secondsPerFight = sim.avgCooldownSeconds + sim.avgRestSeconds;
    const xpPerFight = fightXp({ playerLevel: char.level, wisdom: stats.wisdom, monsterLevel: m.level, monsterHp: m.hp, kind }, p.xp);
    const fightsPerHour = secondsPerFight > 0 ? 3600 / secondsPerFight : 0;
    const xpPerHour = fightsPerHour * sim.winRate * xpPerFight;
    const goldPerHour = fightsPerHour * sim.winRate * expectedGold(m, stats.prospecting, p.itemValue);
    let eligible = true, why = '';
    if (!p.allowedTypes.includes(kind)) { eligible = false; why = `${kind} type not allowed solo`; }
    else if (sim.winRate < p.winRateFloor) { eligible = false; why = `win rate ${pct(sim.winRate)} below floor ${pct(p.winRateFloor)}`; }
    else if (xpPerFight === 0) { eligible = false; why = 'zero xp (level penalty)'; }
    const reason = `${m.code} L${m.level}: ${pct(sim.winRate)} win, ${sim.avgTurns.toFixed(1)} turns, -${sim.avgHpLostPct.toFixed(0)}% HP, ${secondsPerFight.toFixed(1)}s/fight => ${Math.round(xpPerHour)} xp/h, ${Math.round(goldPerHour)} gold/h` + (why ? ` [skip: ${why}]` : '')
      + (sim.unmodeled.length ? ` (unmodeled effects: ${sim.unmodeled.join(',')})` : '');
    out.push({ code: m.code, level: m.level, eligible, winRate: sim.winRate, avgTurns: sim.avgTurns, avgHpLostPct: sim.avgHpLostPct, secondsPerFight, xpPerFight, xpPerHour, goldPerHour, reason, sim });
  }
  return out;
}

/** Eligible candidates (win rate >= floor), best first. */
export function bestMonsterForLevel(char: PickerChar, monsters: readonly MonsterDef[], items: ItemCatalogue, policy: Partial<PickerPolicy> = {}): Candidate[] {
  const p = { ...DEFAULT_PICKER_POLICY, ...policy };
  const score = (c: Candidate) => p.rankBy === 'xp' ? c.xpPerHour : p.rankBy === 'gold' ? c.goldPerHour : c.xpPerHour + p.goldWeight * c.goldPerHour;
  return evaluateMonsters(char, monsters, items, policy).filter((c) => c.eligible).sort((a, b) => score(b) - score(a));
}

export type ItemCatalogue = readonly ItemDef[] | Readonly<Record<string, ItemDef>>;
function resolve(codes: readonly string[], items: ItemCatalogue): ItemDef[] {
  const byCode = new Map<string, ItemDef>(Array.isArray(items) ? (items as ItemDef[]).map((i) => [i.code, i]) : Object.entries(items as Record<string, ItemDef>));
  return codes.flatMap((c) => { const i = byCode.get(c); return i ? [i] : []; });
}
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
