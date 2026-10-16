// craftProfit / sellRoute: what a craft earns, per craft, per gold invested and per cooldown-second. Pure.
import type { WorldIndex } from '../world/index.js';
import { whereToGet, expectedYield } from '../world/sources.js';
import type { PriceBook } from './priceBook.js';

export interface EconomyPolicy {
  /** Fraction of GE sale proceeds lost to fees (0.03 = 3%). No GE fee is documented, so 0; set it if one shows up in real data. */
  geFeePct: number;
  /** GE sale price basis: 'ask' = list just under the lowest sell order (may wait for a buyer); 'bid' = fill the best buy order now. */
  geSell: 'ask' | 'bid';
  /** Gold under the lowest ask when listing. */
  undercut: number;
  /** Seconds of cooldown per item produced by a craft. */
  craftSecondsPerItem: number;
  /** Gather cooldown = gatherBaseSeconds + resourceLevel / gatherLevelDivisor. */
  gatherBaseSeconds: number;
  gatherLevelDivisor: number;
  /** 'gather' = raws you collect yourself (NPC shops still allowed, GE not); 'buy' = raws bought from GE/NPC, never gathered; 'cheapest' = per input, lowest gold + seconds * secondValue. */
  inputMode: 'gather' | 'buy' | 'cheapest';
  /** Gold a cooldown-second of your time is worth when comparing buy vs gather. */
  secondValue: number;
  /** Allow raws that only drop from monsters (needs a fight you may not win; seconds per kill = fightSeconds). */
  allowMonsterDrops: boolean;
  fightSeconds: number;
  /** Items whose GE 7-day volume is below this are not considered sellable on the GE. */
  minVolume7d: number;
  /** ASSUMPTION (not in the public data): XP for one craft / one gather action at the given item/resource level. */
  craftXp: (level: number) => number;
  gatherXp: (level: number) => number;
  /** bestToLevel: only recipes/resources within this many levels below the character's skill level. */
  levelWindow: number;
  /** bestToLevel ranking: 'xp' (xp/s, then gold/s) or 'gold' (gold/s, then xp/s). */
  rankBy: 'xp' | 'gold';
}
export const DEFAULT_ECONOMY_POLICY: EconomyPolicy = {
  geFeePct: 0, geSell: 'ask', undercut: 1, craftSecondsPerItem: 5, gatherBaseSeconds: 30, gatherLevelDivisor: 2,
  inputMode: 'cheapest', secondValue: 1, allowMonsterDrops: false, fightSeconds: 30, minVolume7d: 0,
  craftXp: (l) => 4 + 2 * l, gatherXp: (l) => 4 + 2 * l, levelWindow: 5, rankBy: 'xp',
};
export const withPolicy = (p: Partial<EconomyPolicy> = {}): EconomyPolicy => ({ ...DEFAULT_ECONOMY_POLICY, ...p });

export interface SellOption {
  channel: 'npc' | 'ge';
  npc?: string;
  /** Net gold per unit after fees. */
  unit: number;
  note: string;
  /** GE only: units sold in the last 7 days (how fast this can actually be sold). */
  volume7d?: number;
  /** GE only: units currently listed for sale (competing supply). */
  askQty?: number;
}
export interface SellRoute {
  item: string;
  qty: number;
  /** Best first (by net unit). Empty = nowhere to sell. */
  options: SellOption[];
  best: SellOption | null;
  total: number;
  reason: string;
}

export function sellRoute(item: string, world: WorldIndex, prices: PriceBook, policy: Partial<EconomyPolicy> = {}, qty = 1): SellRoute {
  const p = withPolicy(policy);
  const options: SellOption[] = [];
  for (const r of world.npcItemsByItem.get(item) ?? [])
    if (r.sell_price !== null && r.currency === 'gold') options.push({ channel: 'npc', npc: r.npc, unit: r.sell_price, note: `${r.npc} pays ${r.sell_price}g` });
  const def = world.items.get(item);
  const pe = prices[item];
  if (def?.tradeable !== false && pe && pe.volume7d >= p.minVolume7d) {
    let gross: number | null = null; let note = '';
    if (p.geSell === 'bid') {
      if (pe.bestBuy !== null) { gross = pe.bestBuy; note = `fill best GE buy order at ${pe.bestBuy}g`; }
    } else if (pe.bestSell !== null) {
      gross = Math.max(1, pe.bestSell - p.undercut); note = `list on GE at ${gross}g (lowest ask ${pe.bestSell}g)`;
    } else if (pe.bestBuy !== null) { gross = pe.bestBuy; note = `no asks; fill best GE buy order at ${pe.bestBuy}g`; }
    else if (pe.avg7d !== null) { gross = Math.round(pe.avg7d); note = `no open orders; 7d avg ${gross}g`; }
    if (gross !== null) options.push({ channel: 'ge', unit: gross * (1 - p.geFeePct), note, volume7d: pe.volume7d, askQty: pe.depth.sellQty });
  }
  options.sort((a, b) => b.unit - a.unit);
  const best = options[0] ?? null;
  return {
    item, qty, options, best, total: best ? best.unit * qty : 0,
    reason: best ? `${item}: best is ${best.note} -> ${best.unit.toFixed(1)}g/unit net` : `${item}: no NPC buyer and no usable GE price`,
  };
}

export interface InputLine { code: string; qty: number; how: string; gold: number; seconds: number }
export interface CraftProfit {
  item: string;
  ok: boolean;
  skill: string;
  level: number;
  outputQty: number;
  /** Net sale proceeds for the craft's output. */
  revenue: number;
  /** Gold spent on inputs (GE/NPC purchases; gathered inputs cost 0 gold). */
  inputGold: number;
  gatherSeconds: number;
  craftSeconds: number;
  totalSeconds: number;
  profit: number;
  /** profit / inputGold; null when nothing is spent. */
  perGold: number | null;
  perSecond: number;
  xp: number;
  xpPerSecond: number;
  sale: SellOption | null;
  inputs: InputLine[];
  reason: string;
}

interface Acq { gold: number; seconds: number; how: string; lines: InputLine[] }

/** Cheapest way to hold `qty` of `code`, by gold + seconds * secondValue. Null if impossible. */
function acquire(code: string, qty: number, world: WorldIndex, prices: PriceBook, p: EconomyPolicy, stack: string[]): Acq | null {
  const opts: Acq[] = [];
  const line = (how: string, gold: number, seconds: number): Acq => ({ gold, seconds, how, lines: [{ code, qty, how, gold, seconds }] });
  const item = world.items.get(code);
  const srcs = whereToGet(world, code);
  // NPC shops are always allowed (some goods can be had nowhere else); 'gather' mode only rules out the GE.
  const ask = prices[code]?.bestSell;
  if (p.inputMode !== 'gather' && ask != null && item?.tradeable !== false) opts.push(line(`buy on GE @${ask}`, ask * qty, 0));
  for (const s of srcs) if (s.kind === 'npc' && s.currency === 'gold') opts.push(line(`buy from ${s.npc} @${s.price}`, s.price * qty, 0));
  if (p.inputMode !== 'buy') {
    let g: Acq | null = null;
    for (const s of srcs) {
      let per: number;
      if (s.kind === 'resource') per = p.gatherBaseSeconds + s.level / p.gatherLevelDivisor;
      else if (s.kind === 'monster' && p.allowMonsterDrops) per = p.fightSeconds;
      else continue;
      const secs = (qty / expectedYield(s.rate, s.min, s.max)) * per;
      if (!g || secs < g.seconds) g = line(`${s.kind === 'resource' ? 'gather' : 'fight'} ${s.kind === 'resource' ? s.resource : s.monster}`, 0, secs);
    }
    if (g) opts.push(g);
  }
  if (item?.craft && !stack.includes(code)) {
    const c = item.craft;
    const runs = qty / c.quantity;
    let gold = 0, seconds = runs * c.quantity * p.craftSecondsPerItem; let ok = true;
    const lines: InputLine[] = [];
    for (const ci of c.items) {
      const a = acquire(ci.code, ci.quantity * runs, world, prices, p, [...stack, code]);
      if (!a) { ok = false; break; }
      gold += a.gold; seconds += a.seconds; lines.push(...a.lines);
    }
    if (ok) opts.push({ gold, seconds, how: `craft (${c.skill} ${c.level})`, lines: [{ code, qty, how: `craft (${c.skill} ${c.level})`, gold, seconds }, ...lines] });
  }
  let best: Acq | null = null;
  for (const o of opts) if (!best || o.gold + o.seconds * p.secondValue < best.gold + best.seconds * p.secondValue) best = o;
  return best;
}

const blank = (item: string, skill: string, level: number, reason: string): CraftProfit => ({
  item, ok: false, skill, level, outputQty: 0, revenue: 0, inputGold: 0, gatherSeconds: 0, craftSeconds: 0, totalSeconds: 0, profit: 0,
  perGold: null, perSecond: 0, xp: 0, xpPerSecond: 0, sale: null, inputs: [], reason,
});

/** Profit of ONE craft run of `itemCode`, with every input sourced by the cheapest means the policy allows. */
export function craftProfit(itemCode: string, world: WorldIndex, prices: PriceBook, policy: Partial<EconomyPolicy> = {}): CraftProfit {
  const p = withPolicy(policy);
  const item = world.items.get(itemCode);
  if (!item) return blank(itemCode, '', 0, `${itemCode}: unknown item`);
  const c = item.craft;
  if (!c) return blank(itemCode, '', 0, `${itemCode}: not craftable`);
  const outputQty = c.quantity;
  let inputGold = 0, seconds = 0; const inputs: InputLine[] = [];
  for (const ci of c.items) {
    const a = acquire(ci.code, ci.quantity, world, prices, p, [itemCode]);
    if (!a) return blank(itemCode, c.skill, c.level, `${itemCode}: cannot obtain ${ci.code} under inputMode=${p.inputMode}`);
    inputGold += a.gold; seconds += a.seconds; inputs.push(...a.lines);
  }
  const craftSeconds = outputQty * p.craftSecondsPerItem;
  const gatherSeconds = seconds; // everything beyond the top-level craft: gathering plus nested crafts
  const totalSeconds = gatherSeconds + craftSeconds;
  const sr = sellRoute(itemCode, world, prices, p, outputQty);
  const xp = p.craftXp(c.level);
  const base = { item: itemCode, skill: c.skill, level: c.level, outputQty, inputGold, gatherSeconds, craftSeconds, totalSeconds, xp, xpPerSecond: xp / totalSeconds, inputs };
  if (!sr.best) return { ...base, ok: false, revenue: 0, profit: -inputGold, perGold: inputGold > 0 ? -1 : null, perSecond: -inputGold / totalSeconds, sale: null, reason: `${itemCode}: ${sr.reason}` };
  const profit = sr.total - inputGold;
  return {
    ...base, ok: true, revenue: sr.total, profit,
    perGold: inputGold > 0 ? profit / inputGold : null, perSecond: profit / totalSeconds, sale: sr.best,
    reason: `${itemCode} x${outputQty}: sell ${sr.total.toFixed(0)}g (${sr.best.note}) - inputs ${inputGold.toFixed(0)}g = ${profit.toFixed(0)}g in ${totalSeconds.toFixed(0)}s (${(profit / totalSeconds).toFixed(2)}g/s)`,
  };
}
