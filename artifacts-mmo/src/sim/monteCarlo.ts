import { fightCooldown, restSeconds, seededRng, simulateFight, type MonsterDef } from './fight.js';
import type { CombatStats } from './stats.js';

export interface MonteCarloResult {
  n: number; winRate: number; avgTurns: number;
  /** mean HP lost as % of the starting HP (a loss counts as 100%) */
  avgHpLostPct: number;
  avgCooldownSeconds: number; avgRestSeconds: number;
  unmodeled: string[];
}

export function monteCarlo(player: CombatStats, monster: MonsterDef, n = 200, seed = 1): MonteCarloResult {
  const rng = seededRng(seed);
  let wins = 0, turns = 0, lostPct = 0, cd = 0, rest = 0, unmodeled: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = simulateFight(player, monster, rng);
    unmodeled = r.unmodeled;
    if (r.win) wins++;
    turns += r.turns;
    lostPct += r.hpLost / r.startHp * 100;
    cd += fightCooldown(r.turns, player.haste);
    rest += restSeconds(r.win ? r.hpLost : r.startHp - 1);
  }
  return { n, winRate: wins / n, avgTurns: turns / n, avgHpLostPct: lostPct / n, avgCooldownSeconds: cd / n, avgRestSeconds: rest / n, unmodeled };
}
