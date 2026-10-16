import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadGameData, type GameData, type Item } from '../src/world/data.js';
import { buildWorldIndex } from '../src/world/index.js';
import { priceBook, craftProfit, bestToLevel, sellRoute, type GeOrder } from '../src/economy/index.js';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---- hand-built fixture
const item = (code: string, craft: Item['craft'] = null): Item => ({
  name: code, code, level: 1, type: 'resource', subtype: '', description: '', conditions: [], effects: [], craft, tradeable: true,
});
const fixture = () => buildWorldIndex({
  maps: [], monsters: [], npcs: [], tasks: [], taskRewards: [], events: [],
  items: [
    item('copper_ore'),
    item('cord'),
    item('copper_bar', { skill: 'mining', level: 1, quantity: 1, items: [{ code: 'copper_ore', quantity: 10 }] }),
    item('copper_dagger', { skill: 'weaponcrafting', level: 1, quantity: 1, items: [{ code: 'copper_bar', quantity: 2 }, { code: 'cord', quantity: 1 }] }),
  ],
  resources: [{ name: 'Copper Rocks', code: 'copper_rocks', skill: 'mining', level: 1, drops: [{ code: 'copper_ore', rate: 1, min_quantity: 1, max_quantity: 1 }] }],
  npcItems: [
    { code: 'cord', npc: 'shop', currency: 'gold', buy_price: 20, sell_price: 1 },
    { code: 'copper_bar', npc: 'smith', currency: 'gold', buy_price: null, sell_price: 90 },
  ],
} as unknown as GameData);
const sell = (code: string, price: number, quantity = 1): GeOrder => ({ type: 'sell', code, price, quantity });
const buy = (code: string, price: number, quantity = 1): GeOrder => ({ type: 'buy', code, price, quantity });

test('priceBook: best sides, spread, depth, 7-day volume-weighted average', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const day = 86400000;
  const iso = (ago: number) => new Date(now - ago * day).toISOString();
  const b = priceBook(
    [buy('ore', 4, 2), buy('ore', 6, 1), sell('ore', 9, 5), sell('ore', 7, 3), sell('only_sell', 50)],
    { ore: [{ quantity: 10, price: 10, sold_at: iso(3) }, { quantity: 10, price: 20, sold_at: iso(1) }, { quantity: 100, price: 999, sold_at: iso(10) }] },
    { now },
  );
  const e = b.ore!;
  assert.equal(e.bestBuy, 6); assert.equal(e.bestSell, 7); assert.equal(e.spread, 1);
  assert.deepEqual(e.depth, { buyOrders: 2, buyQty: 3, sellOrders: 2, sellQty: 8 });
  assert.equal(e.volume7d, 20); near(e.avg7d!, 15);
  assert.equal(b.only_sell!.spread, null); assert.equal(b.only_sell!.bestBuy, null); assert.equal(b.only_sell!.avg7d, null);
});

test('craftProfit (cheapest inputs): hand-computed', () => {
  const w = fixture();
  const pb = priceBook([sell('copper_ore', 5), sell('copper_bar', 100), sell('copper_dagger', 301)]);
  // bar: craft = 10 ore bought @5 = 50g + 5s beats GE 100g. dagger: 2 bars = 100g+10s beats GE 200g; cord 20g from shop.
  // sell dagger at 301-1 = 300. inputs 120g, seconds 10 (bars) + 5 (dagger) = 15.
  const r = craftProfit('copper_dagger', w, pb);
  assert.ok(r.ok);
  near(r.revenue, 300); near(r.inputGold, 120); near(r.totalSeconds, 15); near(r.profit, 180);
  near(r.perSecond, 12); near(r.perGold!, 1.5); near(r.xp, 6); near(r.xpPerSecond, 0.4);
  assert.match(r.reason, /copper_dagger/);
});

test('craftProfit (gather mode): raws cost cooldown, not gold; NPC goods still bought', () => {
  const w = fixture();
  const pb = priceBook([sell('copper_ore', 5), sell('copper_bar', 100), sell('copper_dagger', 301)]);
  // ore gather = 30 + 1/2 = 30.5s. bar = 10*30.5 + 5 = 310s. dagger = 2*310 + 5 = 625s, 20g for the cord.
  const r = craftProfit('copper_dagger', w, pb, { inputMode: 'gather' });
  near(r.inputGold, 20); near(r.totalSeconds, 625); near(r.profit, 280); near(r.perSecond, 280 / 625);
  // buy mode never gathers
  const b = craftProfit('copper_dagger', w, pb, { inputMode: 'buy' });
  near(b.inputGold, 120);
});

test('craftProfit: fee policy, missing prices and non-recipes', () => {
  const w = fixture();
  const pb = priceBook([sell('copper_ore', 5), sell('copper_dagger', 301)]);
  const fee = craftProfit('copper_dagger', w, pb, { geFeePct: 0.1 });
  near(fee.revenue, 270);
  const none = craftProfit('copper_dagger', w, priceBook([]), { inputMode: 'buy' });
  assert.equal(none.ok, false); assert.match(none.reason, /cannot obtain/);
  assert.equal(craftProfit('copper_ore', w, pb).ok, false);
  assert.equal(craftProfit('nope', w, pb).ok, false);
  // no buyer for the output at all
  const nb = craftProfit('copper_dagger', w, priceBook([sell('copper_ore', 5)]));
  assert.equal(nb.ok, false); assert.ok(nb.profit < 0);
});

test('sellRoute: NPC vs GE, fee and undercut flip the winner', () => {
  const w = fixture();
  const pb = priceBook([sell('copper_bar', 100)]);
  let r = sellRoute('copper_bar', w, pb, {}, 3);
  assert.equal(r.best!.channel, 'ge'); near(r.best!.unit, 99); near(r.total, 297);
  r = sellRoute('copper_bar', w, pb, { undercut: 20 });
  assert.equal(r.best!.channel, 'npc'); assert.equal(r.best!.npc, 'smith'); near(r.best!.unit, 90);
  r = sellRoute('copper_bar', w, pb, { geFeePct: 0.1 });
  assert.equal(r.best!.channel, 'npc');
  assert.equal(r.options.length, 2);
  assert.equal(sellRoute('copper_ore', w, priceBook([])).best, null);
  // minVolume7d hides GE for items with no sales
  assert.equal(sellRoute('copper_bar', w, pb, { minVolume7d: 1, undercut: 0 }).best!.channel, 'npc');
});

test('bestToLevel: ranked, hand-computed, crafts and gathers', () => {
  const w = fixture();
  const pb = priceBook([sell('copper_ore', 5), sell('copper_bar', 100)]);
  const out = bestToLevel('mining', 1, w, pb);
  assert.deepEqual(out.map((o) => `${o.kind}:${o.code}`), ['craft:copper_bar', 'gather:copper_rocks']);
  near(out[0]!.xpPerSecond, 6 / 5); near(out[0]!.gold, 49); near(out[0]!.goldPerSecond, 9.8);
  near(out[1]!.seconds, 30.5); near(out[1]!.goldPerSecond, 4 / 30.5);
  const byGold = bestToLevel('mining', 1, w, pb, { rankBy: 'gold' });
  assert.equal(byGold[0]!.code, 'copper_bar');
  assert.deepEqual(bestToLevel('mining', 1, w, pb, { levelWindow: -1 }), []);
});

// ---- smoke on real data
const rd = (f: string) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
test('real data: price book and craft opportunities are sane and sorted', () => {
  const world = buildWorldIndex(loadGameData(rd));
  const book = priceBook(rd('ge_orders.json'), rd('ge_history.json'));
  const entries = Object.values(book);
  assert.ok(entries.length > 100);
  for (const e of entries) {
    if (e.bestBuy !== null && e.bestSell !== null) assert.ok(e.bestBuy <= e.bestSell, `crossed book on ${e.code}`);
    assert.ok(e.volume7d >= 0);
  }
  const results = world.data.items.filter((i) => i.craft).map((i) => craftProfit(i.code, world, book)).filter((r) => r.ok);
  assert.ok(results.length > 10);
  assert.ok(results.some((r) => r.perSecond > 0), 'some craft earns positive gold per second');
  for (const r of results) { assert.ok(Number.isFinite(r.perSecond)); assert.ok(r.totalSeconds > 0); assert.ok(r.reason.length > 0); }
  const gathered = world.data.items.filter((i) => i.craft).map((i) => craftProfit(i.code, world, book, { inputMode: 'gather' })).filter((r) => r.ok);
  assert.ok(gathered.some((r) => r.profit > 0));
  const lv = bestToLevel('mining', 20, world, book);
  assert.ok(lv.length > 0);
  for (let i = 1; i < lv.length; i++) assert.ok(lv[i - 1]!.xpPerSecond >= lv[i]!.xpPerSecond - 1e-12, 'sorted by xp/s');
  const gold = bestToLevel('mining', 20, world, book, { rankBy: 'gold' });
  for (let i = 1; i < gold.length; i++) assert.ok(gold[i - 1]!.goldPerSecond >= gold[i]!.goldPerSecond - 1e-12, 'sorted by gold/s');
});
