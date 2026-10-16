// bestToLevel: rank what to do with a skill at a given level, by XP/second and gold/second. Pure.
import type { WorldIndex } from '../world/index.js';
import { expectedYield } from '../world/sources.js';
import type { PriceBook } from './priceBook.js';
import { craftProfit, sellRoute, withPolicy, type EconomyPolicy } from './craft.js';

export interface LevelOption {
  kind: 'craft' | 'gather';
  /** Item code (craft) or resource code (gather). */
  code: string;
  skill: string;
  level: number;
  /** Cooldown seconds for one action (gather) or one full craft including its input gathering (craft). */
  seconds: number;
  xp: number;
  xpPerSecond: number;
  /** Net gold per action/craft (negative = it costs gold to level this way). */
  gold: number;
  goldPerSecond: number;
  reason: string;
}

export function bestToLevel(skill: string, fromLevel: number, world: WorldIndex, prices: PriceBook, policy: Partial<EconomyPolicy> = {}): LevelOption[] {
  const p = withPolicy(policy);
  const lo = fromLevel - p.levelWindow;
  const out: LevelOption[] = [];
  for (const it of world.data.items) {
    const c = it.craft;
    if (!c || c.skill !== skill || c.level > fromLevel || c.level < lo) continue;
    const r = craftProfit(it.code, world, prices, p);
    // An unsellable craft still levels you up: its value is just the (negative) input cost.
    if (r.totalSeconds <= 0) continue;
    if (!r.ok && /cannot obtain/.test(r.reason)) continue;
    out.push({
      kind: 'craft', code: it.code, skill, level: c.level, seconds: r.totalSeconds, xp: r.xp, xpPerSecond: r.xpPerSecond,
      gold: r.profit, goldPerSecond: r.perSecond,
      reason: `craft ${it.code} (lvl ${c.level}): ${r.xpPerSecond.toFixed(2)} xp/s, ${r.perSecond.toFixed(2)} g/s${r.ok ? '' : ' (no buyer, cost only)'}`,
    });
  }
  for (const res of world.data.resources) {
    if (res.skill !== skill || res.level > fromLevel || res.level < lo) continue;
    const seconds = p.gatherBaseSeconds + res.level / p.gatherLevelDivisor;
    let gold = 0;
    for (const d of res.drops) {
      const sr = sellRoute(d.code, world, prices, p);
      if (sr.best) gold += expectedYield(d.rate, d.min_quantity, d.max_quantity) * sr.best.unit;
    }
    const xp = p.gatherXp(res.level);
    out.push({
      kind: 'gather', code: res.code, skill, level: res.level, seconds, xp, xpPerSecond: xp / seconds, gold, goldPerSecond: gold / seconds,
      reason: `gather ${res.code} (lvl ${res.level}): ${(xp / seconds).toFixed(2)} xp/s, ${(gold / seconds).toFixed(2)} g/s from sellable drops`,
    });
  }
  const [a, b] = p.rankBy === 'xp' ? (['xpPerSecond', 'goldPerSecond'] as const) : (['goldPerSecond', 'xpPerSecond'] as const);
  return out.sort((x, y) => y[a] - x[a] || y[b] - x[b] || x.code.localeCompare(y.code));
}
