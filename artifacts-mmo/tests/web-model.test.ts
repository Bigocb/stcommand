import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-ignore plain JS module without types
import * as M from '../web/model.js';

const load = (n: string) => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), 'utf8'));
const data = Object.fromEntries(['maps', 'monsters', 'resources', 'npcs', 'items', 'events'].map((n) => [n, load(n)]));
const tile = (content: any, access = 'standard', transition: any = null) => ({ map_id: 1, name: 'T', skin: 's', x: 0, y: 0, layer: 'overworld', access: { type: access, conditions: [] }, interactions: { content, transition } });

test('classifyTile covers each content type and fallbacks', () => {
  assert.equal(M.classifyTile(tile({ type: 'monster', code: 'chicken' })).kind, 'monster');
  assert.equal(M.classifyTile(tile({ type: 'bank', code: 'bank' })).kind, 'bank');
  assert.equal(M.classifyTile(tile(null, 'blocked')).kind, 'blocked');
  assert.equal(M.classifyTile(tile(null)).kind, 'empty');
  assert.equal(M.classifyTile(tile(null, 'standard', { x: 1, y: 1, layer: 'interior', conditions: [] })).kind, 'transition');
  const mt = M.classifyTile(tile({ type: 'monster', code: 'x' }, 'standard', { x: 1, y: 1 }));
  assert.equal(mt.kind, 'monster'); assert.equal(mt.transition, true);
});

test('buildModel splits layers and sets skill-based colour keys', () => {
  const m = M.buildModel(data);
  for (const l of M.LAYERS) assert.equal(m.layers[l].size, 476);
  const res = [...m.layers.overworld.values()].find((t: any) => t.kind === 'resource');
  assert.ok(res.skill); assert.equal(M.colorKey(res), `resource:${res.skill}`);
  assert.ok(m.bounds.maxX > m.bounds.minX);
});

test('search finds monsters by name and items by drop, case/punctuation-insensitive', () => {
  const m = M.buildModel(data);
  const c = M.search(m.index, 'CHICK');
  assert.equal(c[0].type, 'monster'); assert.ok(c[0].tiles.length > 0);
  const egg = M.search(m.index, 'egg').find((e: any) => e.type === 'item');
  assert.ok(egg && egg.tiles.length > 0);
  assert.deepEqual(M.search(m.index, '   '), []);
  assert.deepEqual(M.search(m.index, 'zzzznotathing'), []);
});

test('describeTile shapes monster, resource and transition details', () => {
  const m = M.buildModel(data);
  const mon = [...m.layers.overworld.values()].find((t: any) => t.code === 'chicken');
  const d = M.describeTile(m, mon);
  assert.equal(d.monster.name, 'Chicken'); assert.ok(d.monster.drops.length <= 4);
  assert.equal(d.monster.drops[0].rate, Math.min(...d.monster.drops.map((x: any) => x.rate)));
  const tr = [...m.layers.underground.values()].find((t: any) => t.interactions.transition);
  assert.ok(M.describeTile(m, tr).transition.layer);
  assert.equal(M.formatCondition({ code: 'k', operator: 'cost', value: 1 }), 'costs 1 x k');
});

test('pathBetween and positionAt move 5 s per tile', () => {
  const p = M.pathBetween({ x: 0, y: 0 }, { x: 2, y: 1 });
  assert.deepEqual(p, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }]);
  assert.deepEqual(M.positionAt({ x: 0, y: 0 }, p, 2500), { x: 0.5, y: 0, done: false });
  assert.deepEqual(M.positionAt({ x: 0, y: 0 }, p, 7500), { x: 1.5, y: 0, done: false });
  assert.deepEqual(M.positionAt({ x: 0, y: 0 }, p, 15000), { x: 2, y: 1, done: true });
  assert.deepEqual(M.positionAt({ x: 3, y: 3 }, [], 0), { x: 3, y: 3, done: true });
});

test('model.js has no DOM access', () => {
  const src = readFileSync(new URL('../web/model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(document|window|canvas|localStorage|fetch)\b/);
});
