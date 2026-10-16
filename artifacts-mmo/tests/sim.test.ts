import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateStats, maxHpForLevel, type ItemDef } from '../src/sim/stats.js';
import { elementDamage, fightCooldown, restSeconds, seededRng, simulateFight, type MonsterDef } from '../src/sim/fight.js';
import { monteCarlo } from '../src/sim/monteCarlo.js';
import { dropChance, fightXp, levelPenalty } from '../src/sim/xp.js';
import { bestMonsterForLevel } from '../src/sim/picker.js';

const load = <T>(f: string): T => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8')) as T;
const monsters = load<MonsterDef[]>('monsters.json');
const items = load<ItemDef[]>('items.json');

const mon = (o: Partial<MonsterDef>): MonsterDef => ({
  code: 'dummy', level: 1, type: 'normal', hp: 100, attack_fire: 0, attack_earth: 0, attack_water: 0, attack_air: 0,
  res_fire: 0, res_earth: 0, res_water: 0, res_air: 0, critical_strike: 0, initiative: 0, effects: [], min_gold: 0, max_gold: 0, drops: [], ...o,
});

test('doc damage example: 100 +20 fire +10 global = 130; vs 30 res = 91; crit = 137', () => {
  assert.equal(elementDamage(100, 10, 20, 0, false), 130);
  assert.equal(elementDamage(100, 10, 20, 30, false), 91);
  assert.equal(elementDamage(100, 10, 20, 30, true), 137); // 136.5 rounds up
});

test('cooldown and rest', () => {
  assert.equal(fightCooldown(20, 10), 36);
  assert.equal(fightCooldown(2, 0), 5);
  assert.equal(restSeconds(1), 3);
  assert.equal(restSeconds(100), 20);
  assert.equal(restSeconds(0), 0);
});

test('xp formula and penalty', () => {
  // (5/10)*20 + 100*0.04 = 14 ; penalty gap 5 => 0.7 => 9.8 -> 10
  assert.equal(levelPenalty(10, 5), 0.7);
  assert.equal(levelPenalty(10, 0), 0);
  assert.equal(levelPenalty(10, 7), 1);
  assert.equal(fightXp({ playerLevel: 10, monsterLevel: 5, monsterHp: 100, wisdom: 0 }), 10);
  // (10/10)*20+60*0.04=22.4, elite 1.4 => 31.36, wisdom 100 => x1.1 = 34.5 -> 34
  assert.equal(fightXp({ playerLevel: 10, monsterLevel: 10, monsterHp: 60, wisdom: 100, kind: 'elite' }), 34);
});

test('drop chance scales with prospecting', () => {
  assert.equal(dropChance(10, 0), 0.1);
  assert.ok(Math.abs(dropChance(10, 100) - 0.11) < 1e-12);
});

test('stats aggregation and level hp', () => {
  const s = aggregateStats(3, [{ code: 'a', effects: [{ code: 'attack_fire', value: 20 }, { code: 'dmg', value: 10 }, { code: 'hp', value: 30 }, { code: 'res_air', value: 5 }, { code: 'heal', value: 9 }] }]);
  assert.equal(s.attack.fire, 20); assert.equal(s.dmg, 10); assert.equal(s.res.air, 5);
  assert.equal(s.maxHp, maxHpForLevel(3) + 30);
  assert.equal(maxHpForLevel(2) - maxHpForLevel(1), 5);
});

test('fight: turn order, win, hand-computed turns', () => {
  const p = aggregateStats(1, [{ code: 'w', effects: [{ code: 'attack_fire', value: 10 }] }]);
  // 100 hp / 10 per hit = 10 player turns; player initiative 100 > 0 so player acts on odd turns => turn 19
  const r = simulateFight(p, mon({ hp: 100, attack_water: 5 }), seededRng(1));
  assert.equal(r.win, true); assert.equal(r.turns, 19);
  assert.equal(r.hpLeft, p.maxHp - 9 * 5);
  assert.equal(r.log[0]!.actor, 'player');
  // monster faster
  const r2 = simulateFight(p, mon({ hp: 100, attack_water: 5, initiative: 500 }), seededRng(1));
  assert.equal(r2.log[0]!.actor, 'monster'); assert.equal(r2.turns, 20);
});

test('fight: loss returns 1 HP, and 100-turn cap loses', () => {
  const weak = aggregateStats(1, []);
  const l = simulateFight(weak, mon({ hp: 1000, attack_fire: 200 }), seededRng(1));
  assert.equal(l.win, false); assert.equal(l.hpLeft, 1);
  const cap = simulateFight({ ...weak, attack: { fire: 1, earth: 0, water: 0, air: 0 } }, mon({ hp: 1000 }), seededRng(1));
  assert.equal(cap.win, false); assert.equal(cap.turns, 100);
});

test('fight: deterministic with seed, crit rate follows RNG', () => {
  const p = { ...aggregateStats(1, [{ code: 'w', effects: [{ code: 'attack_fire', value: 10 }, { code: 'critical_strike', value: 50 }] }]) };
  const m = mon({ hp: 500, attack_water: 1 });
  assert.deepEqual(simulateFight(p, m, seededRng(7)), simulateFight(p, m, seededRng(7)));
  const mc = monteCarlo(p, m, 50, 3);
  assert.deepEqual(mc, monteCarlo(p, m, 50, 3));
});

test('fight: poison hits per player turn after the monster has acted', () => {
  const p = aggregateStats(1, [{ code: 'w', effects: [{ code: 'attack_fire', value: 50 }] }]);
  const r = simulateFight(p, mon({ hp: 100, effects: [{ code: 'poison', value: 7 }] }), seededRng(1));
  // t1 player (no poison yet), t2 monster, t3 player: poison 7 then kills
  assert.equal(r.win, true); assert.equal(r.turns, 3); assert.equal(r.hpLeft, p.maxHp - 7);
});

test('real data smoke: chicken at level 1 with the starter weapon', () => {
  const chicken = monsters.find((m) => m.code === 'chicken')!;
  const starter = items.find((i) => i.type === 'weapon' && i.level === 1 && i.effects.some((e) => e.code.startsWith('attack_')))!;
  const stats = aggregateStats(1, [starter]);
  const mc = monteCarlo(stats, chicken, 100, 1);
  assert.ok(mc.winRate > 0.95, `winRate ${mc.winRate}`);
  const ranked = bestMonsterForLevel({ level: 1, equipped: [starter.code] }, monsters, items);
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((c) => c.winRate >= 0.95 && c.reason.length > 0));
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1]!.xpPerHour >= ranked[i]!.xpPerHour);
  assert.ok(ranked.some((c) => c.code === 'chicken'));
  // an unreachable floor yields nothing
  assert.equal(bestMonsterForLevel({ level: 1, equipped: [] }, monsters, items, { winRateFloor: 1.1 }).length, 0);
});
