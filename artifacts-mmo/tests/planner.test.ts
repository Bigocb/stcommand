import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadGameData, type GameData, type MapTile, type Monster, type Resource, type Item } from '../src/world/data.js';
import { buildWorldIndex } from '../src/world/index.js';
import { restSeconds } from '../src/sim/fight.js';
import {
  decideNext, planHorizon, projectProgress, applyDecision, amortise, DEFAULT_PLANNER_POLICY as P,
  type CharState, type PlannerPolicy,
} from '../src/planner/index.js';

// ---------- hand-built world: a row y=0, x=0..12; bank at 0, monsters at 5 and 12, tree at 3, task master at 1
let id = 1;
const tile = (x: number, content: { type: string; code: string } | null = null): MapTile => ({
  map_id: id++, name: 't', skin: 's', x, y: 0, layer: 'overworld', access: { type: 'standard', conditions: [] },
  interactions: { content, transition: null },
});
const mon = (code: string, o: Partial<Monster> = {}): Monster => ({
  name: code, code, level: 1, type: 'normal', hp: 30, attack_fire: 0, attack_earth: 0, attack_water: 2, attack_air: 0,
  res_fire: 0, res_earth: 0, res_water: 0, res_air: 0, critical_strike: 0, initiative: 10, effects: [],
  min_gold: 0, max_gold: 0, drops: [], ...o,
} as Monster);
const stick: Item = { name: 'stick', code: 'stick', level: 1, type: 'weapon', subtype: '', description: '', conditions: [], effects: [{ code: 'attack_earth', value: 10 }], craft: null, tradeable: true };
const res = (code: string, level: number, skill = 'woodcutting'): Resource => ({ name: code, code, skill, level, drops: [{ code: `${code}_wood`, rate: 1, min_quantity: 1, max_quantity: 1 }] });

function world(extra: Partial<GameData> = {}, tiles?: MapTile[]) {
  const maps = tiles ?? [
    tile(0, { type: 'bank', code: 'bank' }), tile(1, { type: 'tasks_master', code: 'monsters' }), tile(2), tile(3, { type: 'resource', code: 'ash' }),
    tile(4), tile(5, { type: 'monster', code: 'pig' }), tile(6), tile(7), tile(8), tile(9), tile(10), tile(11), tile(12, { type: 'monster', code: 'pig' }),
  ];
  return buildWorldIndex({ maps, items: [stick], resources: [res('ash', 1), res('oak', 5)], monsters: [mon('pig')], npcs: [], npcItems: [], tasks: [], taskRewards: [], events: [], ...extra });
}
const at = (x: number) => ({ layer: 'overworld' as const, x, y: 0 });
const char = (o: Partial<CharState> = {}): CharState => ({
  position: at(5), hp: 120, maxHp: 120, level: 1, skills: {}, inventory: [], inventoryMax: 100, gold: 0, equipped: ['stick'],
  task: null, now: 0, cooldownReadyAt: 0, ...o,
});
const pol = (o: Partial<PlannerPolicy> = {}): PlannerPolicy => ({ ...P, ...o });

test('fights when healthy at a monster tile', () => {
  const d = decideNext(char(), world(), P);
  assert.equal(d.action, 'fight'); assert.equal(d.args.monster, 'pig');
  assert.ok(d.expectedCooldownSeconds >= 5); assert.ok(d.reason.length > 0 && !d.reason.includes('\n'));
});

test('rests before fighting when hp is below the threshold; cooldown matches restSeconds', () => {
  const d = decideNext(char({ hp: 20 }), world(), P);
  assert.equal(d.action, 'rest'); assert.equal(d.expectedCooldownSeconds, restSeconds(100));
  assert.equal(d.plan?.[0]?.action, 'fight');
  // threshold is policy: with restBelowFraction 0 and a trivial monster it fights at 20 hp
  assert.equal(decideNext(char({ hp: 20 }), world(), pol({ restBelowFraction: 0 })).action, 'fight');
});

test('walks to the monster with a plan that ends in the fight', () => {
  const d = decideNext(char({ position: at(0) }), world(), P);
  assert.equal(d.action, 'move'); assert.deepEqual(d.args, { layer: 'overworld', x: 5, y: 0 });
  assert.equal(d.expectedCooldownSeconds, 25);
  assert.equal(d.plan?.at(-1)?.action, 'fight');
});

test('banks when the bag passes the fraction, from anywhere; keeps nothing it should not', () => {
  const full = [{ code: 'pig_meat', quantity: 85 }];
  const away = decideNext(char({ inventory: full }), world(), P);
  assert.equal(away.action, 'move'); assert.equal((away.args as { x: number }).x, 0);
  assert.ok(away.plan?.some((s) => s.action === 'bank_deposit'));
  const atBank = decideNext(char({ position: at(0), inventory: full }), world(), P);
  assert.equal(atBank.action, 'bank_deposit');
  assert.deepEqual(atBank.args.items, full);
  assert.equal(decideNext(char({ inventory: [{ code: 'x', quantity: 70 }] }), world(), P).action, 'fight'); // under 80%
  assert.equal(decideNext(char({ inventory: [{ code: 'x', quantity: 70 }] }), world(), pol({ bankAtFraction: 0.5 })).action, 'move');
});

test('amortise spreads the bank trip over the actions that fill the bag', () => {
  const a = amortise({ actionSeconds: 10, itemsPerAction: 1, capacityItems: 50, roundTripSeconds: 100, depositSeconds: 0, maxActions: 1000 });
  assert.equal(a.actionsPerTrip, 50); assert.equal(a.effSecondsPerAction, 12);
  const b = amortise({ actionSeconds: 10, itemsPerAction: 0, capacityItems: 50, roundTripSeconds: 100, depositSeconds: 0, maxActions: 200 });
  assert.equal(b.effSecondsPerAction, 10.5); // no items: capped by maxActions
});

test('prefers the monster nearer the bank when everything else is equal', () => {
  const near = world({}, [tile(0, { type: 'bank', code: 'bank' }), tile(1), tile(2, { type: 'monster', code: 'pig' }), tile(3), tile(4), tile(5), tile(6)]);
  const far = world({}, [tile(0, { type: 'bank', code: 'bank' }), tile(1), tile(2), tile(3), tile(4), tile(5), tile(6, { type: 'monster', code: 'pig' })]);
  const withDrops = { monsters: [mon('pig', { drops: [{ code: 'pig_meat', rate: 1, min_quantity: 1, max_quantity: 1 }] })] };
  const rate = (w: ReturnType<typeof world>) => projectProgress(char({ position: at(0) }), w, P, 7200).xpPerHour;
  assert.ok(rate(world(withDrops, near.data.maps)) > rate(world(withDrops, far.data.maps)));
});

test('goal weights choose between an xp monster and a gold monster', () => {
  const w = world({ monsters: [mon('xpy', { hp: 60, level: 3 }), mon('rich', { hp: 30, min_gold: 80, max_gold: 120 })] },
    [tile(0, { type: 'bank', code: 'bank' }), tile(1, { type: 'monster', code: 'xpy' }), tile(2, { type: 'monster', code: 'rich' })]);
  assert.equal(decideNext(char({ position: at(1) }), w, pol({ xpWeight: 1, goldWeight: 0 })).args.monster, 'xpy');
  assert.equal(decideNext(char({ position: at(2) }), w, pol({ xpWeight: 0, goldWeight: 1 })).args.monster, 'rich');
});

test('skill goal: gathers the best resource the level allows; higher level unlocks more xp', () => {
  const p = pol({ skillGoal: 'woodcutting' });
  const w = world();
  const d = decideNext(char({ position: at(3) }), w, p);
  assert.equal(d.action, 'gather'); assert.equal(d.args.resource, 'ash');
  assert.equal(d.expect.skill, 'woodcutting'); assert.ok((d.expect.xp ?? 0) > 0);
  assert.ok(d.reason.includes('woodcutting'));
  // oak needs level 5 but has no tile here, so ash is still the only choice; unknown skill falls back to fighting
  assert.equal(decideNext(char(), w, pol({ skillGoal: 'jewelrycrafting' })).action, 'fight');
});

test('skill goal: crafts when materials are in the bag', () => {
  const plank: Item = { ...stick, code: 'plank', type: 'resource', effects: [], craft: { skill: 'cooking', level: 1, items: [{ code: 'ash_wood', quantity: 2 }], quantity: 1 } };
  const wood: Item = { ...stick, code: 'ash_wood', type: 'resource', effects: [] };
  const w = world({ items: [stick, plank, wood] }, [tile(0, { type: 'bank', code: 'bank' }), tile(1, { type: 'resource', code: 'ash' }), tile(2, { type: 'workshop', code: 'cooking' })]);
  // ash is a woodcutting resource, ash_wood the drop
  const p = pol({ skillGoal: 'cooking' });
  const noMats = decideNext(char({ position: at(1) }), w, p);
  assert.equal(noMats.action, 'gather');
  const mats = decideNext(char({ position: at(2), inventory: [{ code: 'ash_wood', quantity: 80 }] }), w, p);
  assert.equal(mats.action, 'craft'); assert.equal(mats.args.code, 'plank');
  assert.deepEqual(mats.expect.consumes, [{ code: 'ash_wood', quantity: (mats.args.quantity as number) * 2 }]);
});

test('task loop: new task, fight it, turn it in, exchange coins', () => {
  const tasks = [{ code: 'pig', level: 1, type: 'monsters', min_quantity: 10, max_quantity: 10, skill: null, rewards: { items: [{ code: 'tasks_coin', quantity: 3 }], gold: 200 } }];
  const w = world({ tasks });
  const p = pol({ doTasks: true });
  assert.equal(decideNext(char({ position: at(1) }), w, p).action, 'task_new');
  assert.equal(decideNext(char({ position: at(5) }), w, p).action, 'move'); // no task yet: go to the master first
  const fighting = decideNext(char({ position: at(5), task: { code: 'pig', type: 'monsters', total: 10, progress: 3 } }), w, p);
  assert.equal(fighting.action, 'fight'); assert.ok(fighting.expect.taskProgress! > 0.9);
  const done = decideNext(char({ position: at(1), task: { code: 'pig', type: 'monsters', total: 10, progress: 10 } }), w, p);
  assert.equal(done.action, 'task_complete'); assert.equal(done.expect.gold, 200);
  assert.equal(decideNext(char({ position: at(1), inventory: [{ code: 'tasks_coin', quantity: 6 }] }), w, p).action, 'task_exchange');
  // coins are kept, not banked
  const bag = decideNext(char({ position: at(0), inventory: [{ code: 'tasks_coin', quantity: 3 }, { code: 'junk', quantity: 90 }], task: { code: 'pig', type: 'monsters', total: 10, progress: 3 } }), w, p);
  assert.equal(bag.action, 'bank_deposit'); assert.deepEqual(bag.args.items, [{ code: 'junk', quantity: 90 }]);
  // doTasks off reproduces the default decision
  const c = char({ position: at(1) });
  assert.equal(decideNext(c, w, pol({ doTasks: false })).action, decideNext(c, w, P).action);
});

test('waitSeconds reports the remaining cooldown', () => {
  const d = decideNext(char({ now: 100, cooldownReadyAt: 112 }), world(), P);
  assert.equal(d.waitSeconds, 12);
  assert.equal(decideNext(char({ now: 100, cooldownReadyAt: 50 }), world(), P).waitSeconds, 0);
});

test('idle with a reason when nothing is possible', () => {
  const w = world({ monsters: [] }, [tile(0, { type: 'bank', code: 'bank' })]);
  const d = decideNext(char({ position: at(0) }), w, P);
  assert.equal(d.action, 'idle'); assert.ok(d.reason.length > 0);
});

test('planHorizon is deterministic, advances time, levels up', () => {
  const w = world();
  const a = planHorizon(char(), w, P, 60), b = planHorizon(char(), w, P, 60);
  assert.deepEqual(a, b);
  assert.equal(a.length, 60);
  for (let i = 1; i < a.length; i++) assert.ok(a[i]!.startsAt >= a[i - 1]!.startsAt);
  assert.ok(a.at(-1)!.after.level > 1 || (a.at(-1)!.after.xp ?? 0) > 0);
  // the input state is not mutated
  const s = char(); planHorizon(s, w, P, 10); assert.deepEqual(s, char());
});

test('applyDecision: bank empties the bag except kept items; rest heals', () => {
  const w = world();
  const s = char({ position: at(0), inventory: [{ code: 'a', quantity: 90 }, { code: 'tasks_coin', quantity: 2 }] });
  const d = decideNext(s, w, pol({ doTasks: true }));
  const r = applyDecision(s, d, w, pol({ doTasks: true }));
  assert.deepEqual(r.state.inventory, [{ code: 'tasks_coin', quantity: 2 }]);
  assert.equal(r.gained.banked[0]!.quantity, 90);
  const h = applyDecision(char({ hp: 10 }), decideNext(char({ hp: 10 }), w, P), w, P);
  assert.equal(h.state.hp, 120);
});

test('projectProgress: positive xp and the bank trips show up', () => {
  const w = world({ monsters: [mon('pig', { drops: [{ code: 'pig_meat', rate: 1, min_quantity: 2, max_quantity: 2 }] })] });
  const pr = projectProgress(char({ position: at(0) }), w, P, 4 * 3600);
  assert.ok(pr.xpPerHour > 0); assert.ok((pr.countByAction.bank_deposit ?? 0) >= 1);
  assert.ok(pr.elapsedSeconds >= 4 * 3600 - 1);
});

// ---------- real data
const real = buildWorldIndex(loadGameData((f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'))));
const start = (o: Partial<CharState> = {}): CharState => char({ position: at(0), equipped: ['wooden_stick'], ...o });

test('real data: level-1 character at (0,0) fights a chicken, rests when low, banks when full', () => {
  const memo = new Map();
  const first = decideNext(start(), real, P, memo);
  assert.equal(first.action, 'move'); assert.ok(first.reason.includes('chicken'));
  assert.equal(first.plan?.at(-1)?.action, 'fight');
  const chickenTile = real.findContent('monster', 'chicken').map((t) => t.x + ',' + t.y);
  const dest = first.plan?.length === 1 ? first.args as { x: number; y: number } : null;
  assert.ok(dest === null || chickenTile.includes(`${dest.x},${dest.y}`));
  const onChicken = real.findContent('monster', 'chicken')[0]!;
  const pos = { layer: onChicken.layer, x: onChicken.x, y: onChicken.y };
  const fight = decideNext(start({ position: pos }), real, P, memo);
  assert.equal(fight.action, 'fight'); assert.equal(fight.args.monster, 'chicken');
  const low = decideNext(start({ position: pos, hp: 30 }), real, P, memo);
  assert.equal(low.action, 'rest');
  const full = decideNext(start({ position: pos, inventory: [{ code: 'egg', quantity: 90 }] }), real, P, memo);
  assert.equal(full.action, 'move'); assert.ok(full.plan?.some((s) => s.action === 'bank_deposit'));
  const bank = real.findContent('bank')[0]!;
  const deposit = decideNext(start({ position: { layer: bank.layer, x: bank.x, y: bank.y }, inventory: [{ code: 'egg', quantity: 90 }] }), real, P, memo);
  assert.equal(deposit.action, 'bank_deposit');
});

test('real data: one-hour projections are positive for combat, tasks and skill levelling', () => {
  const memo = new Map();
  const combat = projectProgress(start(), real, P, 3600, memo);
  assert.ok(combat.xpPerHour > 100 && combat.xpPerHour < 5000, `combat xp/h ${combat.xpPerHour}`);
  assert.ok(combat.goldPerHour > 0);
  const tasks = projectProgress(start(), real, pol({ doTasks: true }), 3600, memo);
  assert.ok(tasks.xpPerHour > 0); assert.ok((tasks.countByAction.task_new ?? 0) >= 1);
  const mining = projectProgress(start(), real, pol({ skillGoal: 'mining' }), 3600, memo);
  assert.ok((mining.xpBySkill.mining ?? 0) > 0);
  assert.equal(planHorizon(start(), real, P, 20, memo).length, 20);
});
