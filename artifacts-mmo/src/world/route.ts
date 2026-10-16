// Route planner: A*-style search over a transition-aware tile graph. Pure.
//
// Movement model (docs.artifactsmmo.com/concepts/maps_and_movement is silent on diagonals and on
// per-tile cost; it only says move uses A* around blocked maps with a 5 s cooldown "per map"):
//   - DEFAULT: 4-neighbour steps, 5 s per tile. This is the conservative upper bound.
//   - policy.diagonals = true switches to 8-neighbour steps (same 5 s each) if live testing shows it.
// Transitions are one action costing 5 s, may cross or stay in a layer, and may carry conditions.
// No geometric heuristic is admissible because a transition can teleport across the map, so the
// heuristic is 0 (uniform-cost A*); the graph is ~1.4k nodes so this is instant.
import type { Condition, Layer, MapTile } from './data.js';
import type { Pos, WorldIndex } from './index.js';

export interface CharacterContext {
  items?: Record<string, number>;
  gold?: number;
  achievements?: Iterable<string>;
  /** level, mining_level, ... for eq/ne/gt/lt conditions. Missing attribute = condition unsatisfied. */
  attributes?: Record<string, number>;
}
export interface RoutePolicy { diagonals?: boolean; secondsPerTile?: number; transitionSeconds?: number }

export type RouteStep =
  | { kind: 'move'; to: Pos; mapId: number; tiles: number; seconds: number }
  | { kind: 'transition'; to: Pos; mapId: number; seconds: number; consumes: Record<string, number> };
export interface RoutePlan {
  ok: true; steps: RouteStep[]; seconds: number; reason: string; goal: Pos;
  /** Total of `cost` conditions along the route (consumed). Checked per use, not cumulatively. */
  consumes: Record<string, number>;
}
export interface RouteFailure { ok: false; reason: string }
export type RouteResult = RoutePlan | RouteFailure;

/** null = satisfied, otherwise a short reason. */
export function checkCondition(c: Condition, ctx: CharacterContext): string | null {
  switch (c.operator) {
    case 'has_item':
      return (ctx.items?.[c.code] ?? 0) >= c.value ? null : `needs item ${c.code}`;
    case 'cost':
      if (c.code === 'gold') return (ctx.gold ?? 0) >= c.value ? null : `needs ${c.value} gold`;
      return (ctx.items?.[c.code] ?? 0) >= c.value ? null : `needs ${c.value} ${c.code} to spend`;
    case 'achievement_unlocked': {
      for (const a of ctx.achievements ?? []) if (a === c.code) return null;
      return `needs achievement ${c.code}`;
    }
    default: {
      const v = ctx.attributes?.[c.code];
      if (v === undefined) return `unknown attribute ${c.code}`;
      const ok = c.operator === 'eq' ? v === c.value : c.operator === 'ne' ? v !== c.value
        : c.operator === 'gt' ? v > c.value : v < c.value;
      return ok ? null : `needs ${c.code} ${c.operator} ${c.value} (have ${v})`;
    }
  }
}

function firstFailure(cs: Condition[], ctx: CharacterContext): string | null {
  for (const c of cs) { const f = checkCondition(c, ctx); if (f) return f; }
  return null;
}

class MinHeap<T> {
  private a: { k: number; v: T }[] = [];
  get size() { return this.a.length; }
  push(k: number, v: T) {
    const a = this.a; a.push({ k, v }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p]!.k <= a[i]!.k) break; [a[p], a[i]] = [a[i]!, a[p]!]; i = p; }
  }
  pop(): { k: number; v: T } | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0]!; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i]!, a[m]!]; i = m;
      }
    }
    return top;
  }
}

const pos = (t: MapTile): Pos => ({ layer: t.layer, x: t.x, y: t.y });

function canEnter(t: MapTile, ctx: CharacterContext): string | null {
  if (t.access.type === 'blocked') return 'blocked';
  if (t.access.type === 'conditional' || t.access.conditions.length) return firstFailure(t.access.conditions, ctx);
  return null;
}

interface Edge { to: MapTile; seconds: number; kind: 'move' | 'transition' }

function neighbours(index: WorldIndex, t: MapTile, ctx: CharacterContext, pol: Required<RoutePolicy>, blockers: Set<string>): Edge[] {
  const out: Edge[] = [];
  const restricted = t.access.type === 'restricted';
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    if (dx && dy && !pol.diagonals) continue;
    const n = index.tileAt(t.layer, t.x + dx, t.y + dy);
    if (!n) continue;
    // Restricted maps only connect to other restricted maps.
    if ((n.access.type === 'restricted') !== restricted) continue;
    const why = canEnter(n, ctx);
    if (why) { if (why !== 'blocked') blockers.add(`tile ${n.layer} ${n.x},${n.y}: ${why}`); continue; }
    out.push({ to: n, seconds: pol.secondsPerTile, kind: 'move' });
  }
  const tr = t.interactions.transition;
  if (tr) {
    const dest = index.tileById.get(tr.map_id);
    if (dest) {
      const why = firstFailure(tr.conditions, ctx) ?? canEnter(dest, ctx);
      if (why) blockers.add(`transition ${t.layer} ${t.x},${t.y} -> ${tr.layer} ${tr.x},${tr.y}: ${why}`);
      else out.push({ to: dest, seconds: pol.transitionSeconds, kind: 'transition' });
    }
  }
  return out;
}

function resolve(index: WorldIndex, p: Pos | number): MapTile | undefined {
  return typeof p === 'number' ? index.tileById.get(p) : index.tileAt(p.layer, p.x, p.y);
}

/** Cheapest route from `from` to any of `goals`. planRoute is the one-goal case. */
export function planRouteToAny(
  index: WorldIndex, from: Pos | number, goals: Array<Pos | number | MapTile>, ctx: CharacterContext = {}, policy: RoutePolicy = {},
): RouteResult {
  const pol: Required<RoutePolicy> = { diagonals: false, secondsPerTile: 5, transitionSeconds: 5, ...policy };
  const start = resolve(index, from);
  if (!start) return { ok: false, reason: `start ${JSON.stringify(from)} is not a known tile` };
  const goalIds = new Set<number>();
  for (const g of goals) {
    const t = typeof g === 'object' && 'map_id' in g ? g : resolve(index, g);
    if (t) goalIds.add(t.map_id);
  }
  if (!goalIds.size) return { ok: false, reason: 'no known goal tile' };

  const dist = new Map<number, number>([[start.map_id, 0]]);
  const prev = new Map<number, { from: MapTile; edge: Edge }>();
  const blockers = new Set<string>();
  const heap = new MinHeap<MapTile>();
  heap.push(0, start);
  const done = new Set<number>();
  let found: MapTile | undefined;
  for (let cur = heap.pop(); cur; cur = heap.pop()) {
    const t = cur.v;
    if (done.has(t.map_id)) continue;
    done.add(t.map_id);
    if (goalIds.has(t.map_id)) { found = t; break; }
    for (const e of neighbours(index, t, ctx, pol, blockers)) {
      const nd = cur.k + e.seconds;
      if (nd < (dist.get(e.to.map_id) ?? Infinity)) {
        dist.set(e.to.map_id, nd); prev.set(e.to.map_id, { from: t, edge: e }); heap.push(nd, e.to);
      }
    }
  }
  if (!found) {
    const why = [...blockers].slice(0, 3).join('; ');
    return { ok: false, reason: `unreachable${why ? ` (gated: ${why})` : ' (no path; region disconnected or blocked)'}` };
  }

  const rev: Array<{ t: MapTile; e: Edge }> = [];
  for (let t = found; t.map_id !== start.map_id;) { const p = prev.get(t.map_id)!; rev.push({ t, e: p.edge }); t = p.from; }
  rev.reverse();
  const steps: RouteStep[] = [];
  const consumes: Record<string, number> = {};
  let prevTile = start;
  for (const { t, e } of rev) {
    if (e.kind === 'move') {
      const last = steps[steps.length - 1];
      if (last && last.kind === 'move') {
        last.tiles++; last.seconds += e.seconds; last.to = pos(t); last.mapId = t.map_id;
      } else steps.push({ kind: 'move', to: pos(t), mapId: t.map_id, tiles: 1, seconds: e.seconds });
    } else {
      const cs: Record<string, number> = {};
      for (const c of prevTile.interactions.transition?.conditions ?? []) if (c.operator === 'cost') {
        cs[c.code] = (cs[c.code] ?? 0) + c.value; consumes[c.code] = (consumes[c.code] ?? 0) + c.value;
      }
      steps.push({ kind: 'transition', to: pos(t), mapId: t.map_id, seconds: e.seconds, consumes: cs });
    }
    prevTile = t;
  }
  const seconds = dist.get(found.map_id)!;
  const nTrans = steps.filter((s) => s.kind === 'transition').length;
  const tiles = steps.reduce((n, s) => n + (s.kind === 'move' ? s.tiles : 0), 0);
  return {
    ok: true, steps, seconds, consumes, goal: pos(found),
    reason: steps.length ? `${tiles} tile(s) + ${nTrans} transition(s) = ${seconds}s` : 'already there',
  };
}

export function planRoute(index: WorldIndex, from: Pos | number, to: Pos | number, ctx: CharacterContext = {}, policy: RoutePolicy = {}): RouteResult {
  return planRouteToAny(index, from, [to], ctx, policy);
}

/** Nearest tile of a content kind by real travel time (not distance). */
export function nearestByRoute(
  index: WorldIndex, from: Pos | number, type: string, code: string | undefined, ctx: CharacterContext = {}, policy: RoutePolicy = {},
): { tile: MapTile; route: RoutePlan } | { tile: null; reason: string } {
  const goals = index.findContent(type, code);
  if (!goals.length) return { tile: null, reason: `no tile with ${type}${code ? ':' + code : ''}` };
  const r = planRouteToAny(index, from, goals, ctx, policy);
  if (!r.ok) return { tile: null, reason: r.reason };
  const tile = index.tileAt(r.goal.layer as Layer, r.goal.x, r.goal.y)!;
  return { tile, route: r };
}
