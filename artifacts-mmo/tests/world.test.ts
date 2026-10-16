import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadGameData, type GameData, type MapTile, type Condition } from '../src/world/data.js';
import { buildWorldIndex } from '../src/world/index.js';
import { planRoute, nearestByRoute, planRouteToAny, checkCondition } from '../src/world/route.js';
import { craftTree } from '../src/world/recipes.js';
import { whereToGet } from '../src/world/sources.js';

const real = loadGameData((f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8')));
const idx = buildWorldIndex(real);

// ---- hand-built fixtures
let nextId = 1;
const tile = (x: number, y: number, o: Partial<MapTile> & { acc?: MapTile['access']['type']; accC?: Condition[]; tr?: { to: MapTile; c?: Condition[] }; content?: MapTile['interactions']['content'] } = {}): MapTile => ({
  map_id: nextId++, name: 't', skin: 's', x, y, layer: o.layer ?? 'overworld',
  access: { type: o.acc ?? 'standard', conditions: o.accC ?? [] },
  interactions: { content: o.content ?? null, transition: o.tr ? { map_id: o.tr.to.map_id, x: o.tr.to.x, y: o.tr.to.y, layer: o.tr.to.layer, conditions: o.tr.c ?? [] } : null },
});
const fixture = (maps: MapTile[], extra: Partial<GameData> = {}) =>
  buildWorldIndex({ maps, items: [], resources: [], monsters: [], npcs: [], npcItems: [], tasks: [], taskRewards: [], events: [], ...extra });

test('loadGameData uses injected reader and rejects non-arrays', () => {
  assert.throws(() => loadGameData(() => ({})), /expected a JSON array/);
  const d = loadGameData((f) => (f === 'maps.json' ? [] : f.endsWith('.json') ? [] : []));
  assert.equal(d.maps.length, 0);
});

test('blocked tiles are routed around; 4-neighbour by default, diagonals opt-in', () => {
  const a = tile(0, 0), b = tile(1, 0, { acc: 'blocked' }), c = tile(2, 0), d = tile(0, 1), e = tile(1, 1), f = tile(2, 1);
  const ix = fixture([a, b, c, d, e, f]);
  const r = planRoute(ix, { layer: 'overworld', x: 0, y: 0 }, { layer: 'overworld', x: 2, y: 0 });
  assert.ok(r.ok); assert.equal(r.seconds, 20); // down, right, right, up
  const dg = planRoute(ix, a.map_id, c.map_id, {}, { diagonals: true });
  assert.ok(dg.ok); assert.equal(dg.seconds, 10);
});

test('unreachable gives a reason', () => {
  const m = [tile(0, 0), tile(1, 0, { acc: 'blocked' }), tile(2, 0)];
  const r = planRoute(fixture(m), m[0]!.map_id, m[2]!.map_id);
  assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /unreachable/);
});

test('conditional tile needs its achievement', () => {
  const cond: Condition[] = [{ code: 'tasks_farmer', operator: 'achievement_unlocked', value: 1 }];
  const m = [tile(0, 0), tile(1, 0, { acc: 'conditional', accC: cond }), tile(2, 0)];
  const ix = fixture(m); const [s0, , s2] = [m[0]!.map_id, 0, m[2]!.map_id];
  const no = planRoute(ix, s0, s2);
  assert.equal(no.ok, false); assert.match((no as { reason: string }).reason, /achievement tasks_farmer/);
  const yes = planRoute(ix, s0, s2, { achievements: ['tasks_farmer'] });
  assert.ok(yes.ok); assert.equal(yes.seconds, 10);
});

test('transitions: cost 5s, cross layers, gated by cost/has_item', () => {
  const up = tile(5, 5, { layer: 'underground' });
  const door = tile(0, 0, { tr: { to: up, c: [{ code: 'gold', operator: 'cost', value: 100 }] } });
  const far = tile(6, 5, { layer: 'underground' });
  const ix = fixture([door, up, far]);
  assert.equal(planRoute(ix, door.map_id, far.map_id, { gold: 50 }).ok, false);
  const r = planRoute(ix, door.map_id, far.map_id, { gold: 100 });
  assert.ok(r.ok); assert.equal(r.seconds, 10); assert.deepEqual(r.consumes, { gold: 100 });
  assert.deepEqual(r.steps.map((s) => s.kind), ['transition', 'move']);
});

test('restricted tiles do not connect to normal tiles by walking', () => {
  const m = [tile(0, 0), tile(1, 0, { acc: 'restricted' })];
  assert.equal(planRoute(fixture(m), m[0]!.map_id, m[1]!.map_id).ok, false);
});

test('checkCondition operators', () => {
  assert.equal(checkCondition({ code: 'level', operator: 'gt', value: 5 }, { attributes: { level: 6 } }), null);
  assert.ok(checkCondition({ code: 'level', operator: 'lt', value: 5 }, { attributes: { level: 6 } }));
  assert.equal(checkCondition({ code: 'k', operator: 'has_item', value: 1 }, { items: { k: 1 } }), null);
});

test('crafting cycles are detected', () => {
  const mk = (code: string, dep: string) => ({ name: code, code, level: 1, type: 'x', subtype: '', description: '', conditions: [], effects: [], tradeable: true,
    craft: { skill: 'mining', level: 1, quantity: 1, items: [{ code: dep, quantity: 1 }] } });
  const ix = fixture([], { items: [mk('a', 'b'), mk('b', 'a')] });
  const t = craftTree(ix, 'a', 1);
  assert.equal(t.cycles.length, 1); assert.deepEqual(t.cycles[0], ['a', 'b', 'a']);
});

// ---- real data smoke tests
test('real data: sizes and structure', () => {
  assert.equal(real.maps.length, 1428);
  assert.ok(real.maps.filter((m) => m.interactions.transition).length >= 30);
  assert.deepEqual([...new Set(real.maps.map((m) => m.layer))].sort(), ['interior', 'overworld', 'underground']);
  assert.ok(idx.findContent('resource', 'copper_rocks').length > 0);
  assert.ok(idx.findContent('workshop', 'weaponcrafting').length > 0);
  assert.ok(idx.findContent('bank').length >= 1);
  assert.ok(idx.findContent('grand_exchange').length === 1);
  assert.ok(idx.findContent('tasks_master').length >= 1);
  assert.ok(idx.findContent('monster', 'chicken').length >= 1);
  assert.equal(idx.tileAt('overworld', 0, 0)?.name, 'Spawn');
});

test('real data: nearest bank from spawn and a route to a chicken', () => {
  const spawn = { layer: 'overworld' as const, x: 0, y: 0 };
  const bank = nearestByRoute(idx, spawn, 'bank', undefined, {});
  assert.ok(bank.tile, JSON.stringify(bank));
  assert.ok(bank.route.seconds > 0 && bank.route.seconds % 5 === 0);
  const chicken = idx.findContent('monster', 'chicken')[0]!;
  const r = planRoute(idx, spawn, chicken);
  assert.ok(r.ok); assert.equal(r.seconds, r.steps.reduce((n, s) => n + s.seconds, 0));
  assert.equal(planRoute(idx, spawn, spawn).ok && (planRoute(idx, spawn, spawn) as { seconds: number }).seconds, 0);
});

test('real data: gated transition respects ctx', () => {
  const t = real.maps.find((m) => m.interactions.transition?.conditions.some((c) => c.operator === 'cost'))!;
  const to = idx.tileById.get(t.interactions.transition!.map_id)!;
  const c = t.interactions.transition!.conditions[0]!;
  const direct = planRouteToAny(idx, t, [to], { items: { [c.code]: c.value }, gold: 1e6 });
  assert.ok(direct.ok); assert.equal(direct.seconds, 5);
});

test('real data: craft tree for a mid-level item', () => {
  const item = real.items.filter((i) => i.craft && i.craft.level >= 10 && i.craft.level <= 20)[0]!;
  const t = craftTree(idx, item.code, 2);
  assert.equal(t.cycles.length, 0);
  assert.deepEqual(t.unknown, []);
  assert.ok(t.craftActions >= 2 && t.totalActions >= t.craftActions);
  assert.ok((t.skillLevels[item.craft!.skill] ?? 0) >= item.craft!.level);
  for (const r of Object.values(t.raw)) assert.ok(r.best, `no source for ${r.code}`);
  const w = whereToGet(idx, 'copper_ore');
  assert.ok(w.some((s) => s.kind === 'resource'));
});
