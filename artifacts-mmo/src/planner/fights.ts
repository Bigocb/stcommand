// Combat evaluation: bestMonsterForLevel re-ranked with travel + banking amortised in.
import type { MapTile } from '../world/data.js';
import { bestMonsterForLevel, evaluateMonsters, type Candidate } from '../sim/picker.js';
import type { MonsterDef } from '../sim/fight.js';
import { aggregateStats, type ItemDef } from '../sim/stats.js';
import { expectedDrops } from '../sim/xp.js';
import { amortise } from './econ.js';
import { bestBankRound, itemValues, memoise, routeCtx, type Memo } from './common.js';
import type { CharState, Expect, PlannerPolicy, World } from './types.js';

export interface FightEval {
  cand: Candidate;
  tiles: MapTile[];
  perFight: Expect; // expected effect of one fight (already weighted by win rate)
  score: number; // value per second incl. travel, rest and banking
  xpPerHour: number; goldPerHour: number;
  fightsPerTrip: number; bankRoundSeconds: number; bankReachable: boolean;
  line: string;
}

const pickerPolicy = (p: PlannerPolicy, itemValue: Record<string, number>) => ({
  winRateFloor: p.winRateFloor, fights: p.monteCarloFights, itemValue,
  rankBy: p.xpWeight <= 0 ? 'gold' as const : p.goldWeight <= 0 ? 'xp' as const : 'combined' as const,
  goldWeight: p.xpWeight > 0 ? p.goldWeight / p.xpWeight : 1,
});

const monsterDefs = (world: World, maxLevel: number): MonsterDef[] =>
  world.data.monsters.filter((m) => m.level <= maxLevel && world.findContent('monster', m.code).length > 0) as unknown as MonsterDef[];

function build(state: CharState, world: World, p: PlannerPolicy, memo: Memo, cands: Candidate[], iv: Record<string, number>): FightEval[] {
  const ctx = routeCtx(state);
  const stats = aggregateStats(state.level, state.equipped.flatMap((c) => { const i = world.items.get(c); return i ? [i as unknown as ItemDef] : []; }));
  const out: FightEval[] = [];
  for (const c of cands) {
    const m = world.monsters.get(c.code)!;
    const tiles = world.findContent('monster', c.code);
    const round = bestBankRound(world, tiles, ctx, memo);
    const drops = expectedDrops(m.drops, stats.prospecting).map((d) => ({ code: d.code, quantity: d.perKill * c.winRate }));
    const dropItems = drops.reduce((n, d) => n + d.quantity, 0);
    const coin = c.winRate * (m.min_gold + m.max_gold) / 2;
    const dropGold = drops.reduce((n, d) => n + d.quantity * (iv[d.code] ?? 0), 0);
    const am = amortise({
      actionSeconds: c.secondsPerFight, itemsPerAction: dropItems, capacityItems: Math.max(1, state.inventoryMax * p.bankAtFraction),
      roundTripSeconds: round.seconds, depositSeconds: p.bankActionSeconds, maxActions: p.maxActionsPerTrip,
    });
    const xp = c.winRate * c.xpPerFight;
    const value = p.xpWeight * xp + p.goldWeight * (coin + dropGold);
    const eff = am.effSecondsPerAction;
    out.push({
      cand: c, tiles, score: value / eff, xpPerHour: 3600 * xp / eff, goldPerHour: 3600 * (coin + dropGold) / eff,
      fightsPerTrip: am.actionsPerTrip, bankRoundSeconds: round.seconds, bankReachable: round.reachable,
      perFight: { skill: 'combat', xp, gold: coin, items: drops, hpLost: c.avgHpLostPct / 100 * state.maxHp },
      line: `${c.code} L${c.level} ${(c.winRate * 100).toFixed(0)}% win, ${Math.round(3600 * xp / eff)} xp/h, ${Math.round(3600 * (coin + dropGold) / eff)} gold/h incl. ${Math.round(am.tripOverheadSeconds)}s bank trip per ${Math.round(am.actionsPerTrip)} fights`,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.cand.code.localeCompare(b.cand.code));
}

/** Eligible monsters for this character, best first (win-rate floor applied by the picker). */
export function rankMonsters(state: CharState, world: World, p: PlannerPolicy, memo: Memo): FightEval[] {
  const key = `fights|${state.level}|${state.equipped.join(',')}|${state.maxHp}|${p.winRateFloor}|${p.xpWeight}|${p.goldWeight}|${p.monteCarloFights}|${p.bankAtFraction}|${state.inventoryMax}`;
  return memoise(memo, key, () => {
    const iv = itemValues(world, p, memo);
    const char = { level: state.level, equipped: state.equipped };
    const top = bestMonsterForLevel(char, monsterDefs(world, state.level + 10), world.data.items as unknown as ItemDef[], pickerPolicy(p, iv)).slice(0, Math.max(1, p.topK));
    return build(state, world, p, memo, top, iv);
  });
}

/** One specific monster (e.g. a task target); null when it cannot be fought safely or has no tile. */
export function evalMonster(state: CharState, world: World, p: PlannerPolicy, memo: Memo, code: string): { ev: FightEval | null; why: string } {
  const key = `fight1|${code}|${state.level}|${state.equipped.join(',')}|${state.maxHp}|${p.winRateFloor}|${p.monteCarloFights}|${p.bankAtFraction}|${state.inventoryMax}`;
  return memoise(memo, key, () => {
    const m = world.monsters.get(code);
    if (!m) return { ev: null, why: `unknown monster ${code}` };
    if (!world.findContent('monster', code).length) return { ev: null, why: `${code} has no map tile` };
    const iv = itemValues(world, p, memo);
    const [c] = evaluateMonsters({ level: state.level, equipped: state.equipped }, [m as unknown as MonsterDef], world.data.items as unknown as ItemDef[], pickerPolicy(p, iv));
    if (!c) return { ev: null, why: 'no evaluation' };
    if (!c.eligible) return { ev: null, why: c.reason };
    return { ev: build(state, world, p, memo, [c], iv)[0]!, why: c.reason };
  });
}
