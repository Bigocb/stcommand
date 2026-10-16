// Skill levelling: best gather resource or single-level recipe for a target skill, by xp per second.
import type { Resource } from '../world/data.js';
import { craftTree } from '../world/recipes.js';
import { expectedYield } from '../world/sources.js';
import { predictCrafting, predictGathering } from '../api/cooldown.js';
import { amortise, craftXp, gatherXp, invMap } from './econ.js';
import { bestBankRound, memoise, routeCtx, type Memo, type Visit } from './common.js';
import type { CharState, PlannerPolicy, World } from './types.js';

interface Option {
  xpPerSecond: number; line: string;
  visit: (s: CharState) => Visit | null; // concrete next step given the bag
}

const skillLevel = (s: CharState, skill: string): number => (skill === 'combat' ? s.level : s.skills[skill]?.level ?? 1);

/** Cooldown reduction % from equipped tools: items carry e.g. {code:'mining', value:-10}. */
function toolReduction(s: CharState, world: World, skill: string): number {
  let r = 0;
  for (const c of s.equipped) for (const e of world.items.get(c)?.effects ?? []) if (e.code === skill && e.value < 0) r += -e.value;
  return Math.min(r, 90);
}

function gatherOptions(s: CharState, world: World, p: PlannerPolicy, memo: Memo, skill: string): Option[] {
  const lv = skillLevel(s, skill), ctx = routeCtx(s), red = toolReduction(s, world, skill);
  const out: Option[] = [];
  for (const r of world.data.resources as Resource[]) {
    if (r.skill !== skill || r.level > lv) continue;
    const tiles = world.findContent('resource', r.code);
    if (!tiles.length) continue;
    const xp = gatherXp(r.level, lv, p);
    if (xp <= 0) continue;
    const cd = predictGathering(r.level, red);
    const items = r.drops.map((d) => ({ code: d.code, quantity: expectedYield(d.rate, d.min_quantity, d.max_quantity) }));
    const per = items.reduce((n, i) => n + i.quantity, 0);
    const round = bestBankRound(world, tiles, ctx, memo);
    const am = amortise({ actionSeconds: cd, itemsPerAction: per, capacityItems: Math.max(1, s.inventoryMax * p.bankAtFraction), roundTripSeconds: round.seconds, depositSeconds: p.bankActionSeconds, maxActions: p.maxActionsPerTrip });
    out.push({
      xpPerSecond: xp / am.effSecondsPerAction,
      line: `gather ${r.code} (${skill} L${r.level}): ${xp} xp/${cd}s, ${Math.round(3600 * xp / am.effSecondsPerAction)} xp/h incl. banking`,
      visit: () => ({ tiles, action: 'gather', args: { resource: r.code }, cooldown: cd, expect: { skill, xp, items }, keep: [], fights: false,
        reason: `level ${skill}: gather ${r.code} (${xp} xp per ${cd}s action)` }),
    });
  }
  return out;
}

function craftOptions(s: CharState, world: World, p: PlannerPolicy, memo: Memo, skill: string): Option[] {
  const lv = skillLevel(s, skill), ctx = routeCtx(s);
  const out: Option[] = [];
  const workshops = world.findContent('workshop', skill);
  if (!workshops.length) return out;
  for (const item of world.data.items) {
    const cr = item.craft;
    if (!cr || cr.skill !== skill || cr.level > lv) continue;
    const xpRun = craftXp(item.level, lv, p) * 1; // xp per crafted run (assumed per run)
    if (xpRun <= 0) continue;
    const tree = craftTree(world, item.code, 1);
    if (tree.root.kind !== 'craft' || tree.cycles.length || tree.unknown.length || !tree.root.children.every((c) => c.kind === 'raw')) continue;
    // every ingredient must be gatherable with a skill the character has
    const ing: { code: string; qty: number; res: Resource; tiles: ReturnType<World['findContent']> }[] = [];
    let ok = true;
    for (const c of cr.items) {
      const best = tree.raw[c.code]?.best;
      if (!best || best.kind !== 'resource' || best.level > skillLevel(s, best.skill) || !best.tiles.length) { ok = false; break; }
      ing.push({ code: c.code, qty: c.quantity, res: world.resources.get(best.resource)!, tiles: best.tiles });
    }
    if (!ok) continue;
    const inputUnits = ing.reduce((n, i) => n + i.qty, 0);
    const cap = Math.max(1, s.inventoryMax * p.bankAtFraction);
    const batch = Math.max(1, Math.floor(cap / 2 / inputUnits));
    let gatherSec = 0, travel = bestBankRound(world, workshops, ctx, memo).seconds;
    for (const i of ing) {
      const d = i.res.drops.find((x) => x.code === i.code)!;
      gatherSec += i.qty / expectedYield(d.rate, d.min_quantity, d.max_quantity) * predictGathering(i.res.level, toolReduction(s, world, i.res.skill));
      travel += bestBankRound(world, i.tiles, ctx, memo).seconds;
    }
    const craftSec = predictCrafting(cr.quantity);
    const perRun = gatherSec + craftSec + (travel + p.bankActionSeconds) / batch;
    out.push({
      xpPerSecond: xpRun / perRun,
      line: `craft ${item.code} (${skill} L${cr.level}): ${xpRun} xp/run, ${Math.round(perRun)}s/run incl. gathering ${ing.map((i) => i.code).join('+')}, batches of ${batch}`,
      visit: (st) => {
        const have = invMap(st.inventory);
        const keep = ing.map((i) => i.code);
        for (const i of ing) {
          const need = i.qty * batch;
          if ((have[i.code] ?? 0) + 1e-9 < need) {
            const d = i.res.drops.find((x) => x.code === i.code)!;
            const cd = predictGathering(i.res.level, toolReduction(st, world, i.res.skill));
            const gx = gatherXp(i.res.level, skillLevel(st, i.res.skill), p);
            return { tiles: i.tiles, action: 'gather', args: { resource: i.res.code }, cooldown: cd, keep, fights: false,
              expect: { skill: i.res.skill, xp: gx, items: i.res.drops.map((x) => ({ code: x.code, quantity: expectedYield(x.rate, x.min_quantity, x.max_quantity) })) },
              reason: `craft ${item.code}: need ${need} ${i.code} for ${batch} runs, have ${Math.floor(have[i.code] ?? 0)}; gather at ${i.res.code}` };
          }
        }
        const qty = batch * cr.quantity;
        return { tiles: workshops, action: 'craft', args: { code: item.code, quantity: qty }, cooldown: predictCrafting(qty), keep, fights: false,
          expect: { skill, xp: xpRun * batch, consumes: ing.map((i) => ({ code: i.code, quantity: i.qty * batch })), items: [{ code: item.code, quantity: qty }] },
          reason: `craft ${qty} ${item.code} (${skill} xp ${xpRun * batch}) with materials in bag` };
      },
    });
  }
  return out;
}

/** Best way to level `skill` right now, or a reason there is none. */
export function chooseSkillVisit(s: CharState, world: World, p: PlannerPolicy, memo: Memo, skill: string): { visit: Visit } | { none: string } {
  const lv = skillLevel(s, skill);
  const key = `skill|${skill}|${lv}|${s.equipped.join(',')}|${s.inventoryMax}|${p.bankAtFraction}|${Object.entries(s.skills).map(([k, v]) => k + v.level).join(',')}`;
  const best = memoise(memo, key, () => {
    const all = [...gatherOptions(s, world, p, memo, skill), ...craftOptions(s, world, p, memo, skill)];
    all.sort((a, b) => b.xpPerSecond - a.xpPerSecond || a.line.localeCompare(b.line));
    return all[0] ?? null;
  });
  if (!best) return { none: `no gatherable resource or craftable recipe for ${skill} at level ${lv}` };
  const v = best.visit(s);
  if (!v) return { none: `best option for ${skill} is not actionable` };
  return { visit: { ...v, reason: `${v.reason} [best: ${best.line}]` } };
}
