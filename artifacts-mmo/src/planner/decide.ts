// decideNext: one explainable decision for one character. Pure; memo is an optional cache the caller owns.
import { planRouteToAny } from '../world/route.js';
import type { MapTile } from '../world/data.js';
import { restSeconds } from '../sim/fight.js';
import { DEFAULT_PLANNER_POLICY } from './policy.js';
import { invMap, used } from './econ.js';
import { evalMonster, rankMonsters, type FightEval } from './fights.js';
import { chooseSkillVisit } from './skill.js';
import { posOf, routeCtx, samePos, step, type Memo, type Visit } from './common.js';
import type { CharState, Decision, PlanStep, PlannerPolicy, TaskState, World } from './types.js';

const TASK_ACTION_SECONDS = 3;

function fightVisit(ev: FightEval, extra: Partial<Visit['expect']> = {}, keep: string[] = [], why = ''): Visit {
  const cd = Math.round(ev.cand.sim.avgCooldownSeconds);
  return {
    tiles: ev.tiles, action: 'fight', args: { monster: ev.cand.code }, cooldown: cd, fights: true, keep,
    expect: { ...ev.perFight, ...extra },
    reason: `fight ${ev.cand.code}${why ? ` (${why})` : ''}: ${ev.line}`,
  };
}

/** Deterministic pick of the monster task a task_new would be assumed to give (best eligible by xp+gold score). */
export function pickTaskFor(s: CharState, world: World, p: PlannerPolicy, memo: Memo): { task: TaskState; ev: FightEval } | null {
  let best: { task: TaskState; ev: FightEval } | null = null;
  for (const t of world.data.tasks) {
    if (t.type !== 'monsters' || t.level > s.level) continue;
    const { ev } = evalMonster(s, world, p, memo, t.code);
    if (!ev) continue;
    if (!best || ev.score > best.ev.score || (ev.score === best.ev.score && t.code < best.task.code))
      best = { task: { code: t.code, type: 'monsters', total: Math.round((t.min_quantity + t.max_quantity) / 2), progress: 0 }, ev };
  }
  return best;
}

function taskVisit(s: CharState, world: World, p: PlannerPolicy, memo: Memo): Visit | { none: string } {
  const masters = world.findContent('tasks_master', 'monsters');
  if (!masters.length) return { none: 'no tasks master on the map' };
  const keep = ['tasks_coin'];
  const here = world.tileAt(s.position.layer, s.position.x, s.position.y)?.interactions.content;
  const atMaster = here?.type === 'tasks_master';
  const coins = invMap(s.inventory)['tasks_coin'] ?? 0;
  const t = s.task;
  const base = { tiles: masters, args: {}, cooldown: TASK_ACTION_SECONDS, fights: false, keep };
  if (t && t.progress >= t.total) {
    const def = world.data.tasks.find((x) => x.code === t.code && x.type === t.type);
    return { ...base, action: 'task_complete', expect: { taskDone: true, gold: def?.rewards.gold ?? 0, items: def?.rewards.items ?? [] },
      reason: `task ${t.code} done (${t.progress}/${t.total}): turn it in for gold and coins` };
  }
  if (atMaster && coins >= p.coinExchangeAt)
    return { ...base, action: 'task_exchange', expect: { consumes: [{ code: 'tasks_coin', quantity: p.coinExchangeAt }] },
      reason: `at the tasks master with ${coins} tasks_coin >= ${p.coinExchangeAt}: exchange for a reward` };
  if (!t) {
    if (!pickTaskFor(s, world, p, memo)) return { none: 'no monster task is safely fightable at this level' };
    return { ...base, action: 'task_new', expect: {}, reason: 'no active task: accept a new one at the tasks master' };
  }
  if (t.type !== 'monsters') return { none: `task ${t.code} is a ${t.type} task, only monster tasks are automated` };
  const { ev, why } = evalMonster(s, world, p, memo, t.code);
  if (!ev) return { none: `cannot do task ${t.code}: ${why}` };
  return fightVisit(ev, { taskProgress: ev.cand.winRate }, keep, `task ${t.progress}/${t.total}`);
}

function pickJob(s: CharState, world: World, p: PlannerPolicy, memo: Memo): { visit: Visit; note: string } | { none: string } {
  let note = '';
  if (p.skillGoal && p.skillGoal !== 'combat') {
    const r = chooseSkillVisit(s, world, p, memo, p.skillGoal);
    if ('visit' in r) return { visit: r.visit, note };
    note = `${r.none}; falling back. `;
  }
  if (p.doTasks) {
    const r = taskVisit(s, world, p, memo);
    if ('tiles' in r) return { visit: r, note };
    note += `${r.none}; falling back. `;
  }
  const ranked = rankMonsters(s, world, p, memo);
  const best = ranked[0];
  if (!best) return { none: `${note}no monster clears the ${Math.round(p.winRateFloor * 100)}% win-rate floor` };
  return { visit: fightVisit(best, {}, p.doTasks ? ['tasks_coin'] : []), note };
}

export function decideNext(state: CharState, world: World, policy: PlannerPolicy = DEFAULT_PLANNER_POLICY, memo: Memo = new Map()): Decision {
  const wait = Math.max(0, state.cooldownReadyAt - state.now);
  const mk = (d: Omit<Decision, 'waitSeconds'>): Decision => ({ ...d, waitSeconds: wait });
  const idle = (reason: string) => mk({ action: 'idle', args: {}, expectedCooldownSeconds: 0, reason, expect: {} });

  const job = pickJob(state, world, policy, memo);
  if ('none' in job) return idle(job.none);
  let visit = job.visit;
  const jobStep = step(visit.action, visit.args, visit.cooldown, visit.reason);
  const prefix = job.note;

  // 1. bank when the bag is (nearly) full of things we are not holding on purpose
  const total = used(state.inventory);
  const unprotected = state.inventory.filter((i) => !visit.keep.includes(i.code) && i.quantity > 0);
  const frac = total / Math.max(1, state.inventoryMax);
  const full = frac >= policy.bankAtFraction || total >= state.inventoryMax - 1;
  let tail: PlanStep[] = [];
  let bankNote = '';
  if (full && unprotected.length) {
    const banks = world.findContent('bank');
    if (banks.length) {
      tail = [jobStep];
      bankNote = `bag ${Math.round(frac * 100)}% full (>= ${Math.round(policy.bankAtFraction * 100)}%): bank first. `;
      visit = { tiles: banks, action: 'bank_deposit', args: { items: unprotected.map((i) => ({ code: i.code, quantity: Math.floor(i.quantity) })).filter((i) => i.quantity > 0) },
        cooldown: policy.bankActionSeconds, fights: false, keep: visit.keep, expect: { bank: true, keep: visit.keep },
        reason: `${bankNote}deposit ${unprotected.reduce((n, i) => n + i.quantity, 0)} items` };
    }
  } else if (full && (visit.action === 'gather' || visit.action === 'fight')) return idle(`${prefix}bag is full of items needed for the current job and nothing can be banked`);

  // 2. rest before a fight when hp is low
  if (visit.fights && visit.action === 'fight') {
    const need = Math.max(policy.restBelowFraction * state.maxHp, (visit.expect.hpLost ?? 0) * 1.25 + 1);
    if (state.hp < need && state.hp < state.maxHp) {
      const heal = state.maxHp - state.hp;
      return mk({ action: 'rest', args: {}, expectedCooldownSeconds: restSeconds(heal),
        reason: `${prefix}hp ${Math.round(state.hp)}/${state.maxHp} below ${Math.round(need)} needed to fight safely: rest`,
        expect: { hpRestored: heal }, plan: [jobStep] });
    }
  }

  // 3. already at the work site: do it; otherwise take the first route step
  const here = visit.tiles.find((t) => samePos(posOf(t), state.position));
  if (here) {
    return mk({ action: visit.action, args: visit.args, expectedCooldownSeconds: visit.cooldown, reason: prefix + visit.reason, expect: visit.expect, ...(tail.length ? { plan: tail } : {}) });
  }
  const r = planRouteToAny(world, state.position, visit.tiles as MapTile[], routeCtx(state));
  if (!r.ok) return idle(`${prefix}cannot reach ${visit.action} site: ${r.reason}`);
  const first = r.steps[0]!;
  const rest: PlanStep[] = r.steps.slice(1).map((st) => step(st.kind === 'move' ? 'move' : 'transition', { ...st.to }, st.seconds, `${st.kind} to ${st.to.layer} ${st.to.x},${st.to.y}`));
  const plan = [...rest, step(visit.action, visit.args, visit.cooldown, visit.reason), ...tail];
  const args = first.kind === 'move' ? { ...first.to } : { to: { ...first.to } };
  return mk({
    action: first.kind === 'move' ? 'move' : 'transition', args, expectedCooldownSeconds: first.seconds,
    reason: `${prefix}${bankNote}go to ${r.goal.layer} ${r.goal.x},${r.goal.y} (${r.reason}) to ${visit.action === 'bank_deposit' ? 'bank' : visit.reason}`,
    expect: { moveTo: { ...first.to } }, plan,
  });
}
