// Dominion API balance simulation: four simple bots.
//
// Each bot reads a stale view (its own worlds current, everyone else's a few ticks old) and
// returns an ordered list of actions. The engine runs them in order until the bot's bandwidth
// runs out, and drops actions that turn out to be invalid on the real state (they still cost
// bandwidth, like a failed API call). The bots are meant to play like a first-week script:
// sensible priorities, no lookahead, no coordination.

import {
  type Action,
  type Strategy,
  type View,
  type World,
  chartCostOf,
  claimCostOf,
  hopsFromOwned,
  isContested,
  laneKey,
} from './rules.ts';

export type Bot = (v: View) => Action[];

interface Ctx {
  v: View;
  mine: World[];
  bank: number; // planned spend is taken off as actions are chosen
  bw: number; // planned bandwidth left
  out: Action[];
  remaining: number; // ticks left in the season
}

function ctx(v: View): Ctx {
  return {
    v,
    mine: v.worlds.filter((w) => w.owner === v.me),
    bank: v.myBank,
    bw: v.budget,
    out: [],
    remaining: v.config.seasonLength - v.tick,
  };
}

function push(c: Ctx, type: Action['type'], target: number, cost: number): boolean {
  const bw = c.v.config.actionBw[type] ?? 1;
  if (c.bw < bw || c.bank < cost) return false;
  c.bw -= bw;
  c.bank -= cost;
  c.out.push({ player: c.v.me, type, target });
  return true;
}

/** Unowned worlds next to one of mine (or edge worlds if I hold nothing). */
function frontier(c: Ctx): World[] {
  const { v } = c;
  if (c.mine.length === 0) return v.worlds.filter((w) => w.owner === null && w.ring === v.config.rings - 1);
  const seen = new Set<number>();
  const res: World[] = [];
  for (const m of c.mine) {
    for (const n of v.adj[m.id]!) {
      const w = v.worlds[n]!;
      if (w.owner === null && !seen.has(n)) {
        seen.add(n);
        res.push(w);
      }
    }
  }
  return res;
}

/** Would one more world still leave me at least `minBw` net bandwidth? */
function canHoldMore(c: Ctx, minBw: number): boolean {
  const cfg = c.v.config;
  const h = c.mine.length + 1;
  const net = cfg.bandwidthBase + cfg.bandwidthK * Math.pow(h, cfg.bandwidthExponent) - cfg.upkeepBw * h;
  return net >= minBw;
}

/** Lane hops from each world to the nearest world held by someone else. */
function distToEnemy(v: View): Map<number, number> {
  const dist = new Map<number, number>();
  let frontier: number[] = [];
  for (const w of v.worlds) {
    if (w.owner !== null && w.owner !== v.me) {
      dist.set(w.id, 0);
      frontier.push(w.id);
    }
  }
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const id of frontier) for (const n of v.adj[id]!) if (!dist.has(n)) (dist.set(n, d), next.push(n));
    frontier = next;
  }
  return dist;
}

function leaderMult(v: View, owner: number | null): number {
  return owner !== null && owner === v.leader ? 1 + v.config.leaderWeight : 1;
}

/** Garrison any of my worlds whose unrest is above `limit`, worst first. */
function calm(c: Ctx, limit: number, reserve = 0): void {
  const cfg = c.v.config;
  const hot = c.mine.filter((w) => w.unrest > limit && w.garrison < cfg.garrisonMax).sort((a, b) => b.unrest - a.unrest);
  for (const w of hot) {
    if (c.bank - cfg.garrisonCost < reserve) break;
    push(c, 'garrison', w.id, cfg.garrisonCost);
  }
}

function claimBest(c: Ctx, score: (w: World) => number, reserve: number, maxClaims: number, minBw: number): void {
  const cands = frontier(c)
    .map((w) => ({ w, s: score(w), cost: claimCostOf(c.v.config, c.v.worlds, w) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.w.id - b.w.id);
  let n = 0;
  for (const x of cands) {
    if (n >= maxClaims || !canHoldMore(c, minBw)) break;
    if (c.bank - x.cost < reserve) continue;
    if (push(c, 'claim', x.w.id, x.cost)) {
      n++;
      c.mine.push({ ...x.w, owner: c.v.me });
    }
  }
}

// --------------------------------------------------------------------------------------------
// Scorcher: take worlds, strip them, move on.
// --------------------------------------------------------------------------------------------
export const scorcher: Bot = (v) => {
  const c = ctx(v);
  const cfg = v.config;
  calm(c, 70, 10);
  // Strip conquered worlds while they are still productive, and everything near the end.
  for (const w of [...c.mine].sort((a, b) => b.yield - a.yield)) {
    const lateGame = c.remaining <= cfg.stripBurst / cfg.stripDecay;
    if (w.unrest > 55) continue;
    if ((w.captured && w.stripCount < 2) || (lateGame && w.stripCount < 1) || (w.stripCount === 0 && w.yield > 4)) {
      push(c, 'strip', w.id, 0);
    }
  }
  // At the bandwidth cap, drop the most stripped-out worlds to make room for fresh ones.
  if (!canHoldMore(c, 3)) {
    const spent = c.mine.filter((w) => w.stripCount >= 2 && w.yield < 2 * cfg.upkeepRes + 0.5 && w.id !== c.mine[0]?.id).sort((a, b) => a.yield - b.yield);
    for (const w of spent.slice(0, 2)) {
      push(c, 'abandon', w.id, 0);
      c.mine = c.mine.filter((m) => m.id !== w.id);
    }
  }
  // Attack weak neighbours.
  const targets: { w: World; s: number }[] = [];
  const seen = new Set<number>();
  for (const m of c.mine) {
    for (const n of v.adj[m.id]!) {
      const w = v.worlds[n]!;
      if (w.owner === null || w.owner === v.me || seen.has(n)) continue;
      seen.add(n);
      const p = cfg.attackPower / (cfg.attackPower + w.garrison + 1);
      targets.push({ w, s: w.yield * p * leaderMult(v, w.owner) });
    }
  }
  targets.sort((a, b) => b.s - a.s || a.w.id - b.w.id);
  for (const x of targets.slice(0, 2)) {
    if (c.bank < cfg.attackCost + 15 || !canHoldMore(c, 2.5)) break;
    push(c, 'attack', x.w.id, cfg.attackCost);
  }
  claimBest(c, (w) => w.yield / claimCostOf(cfg, v.worlds, w), 10, 2, 2.5);
  return c.out;
};

// --------------------------------------------------------------------------------------------
// Terraformer: a compact, well-guarded, ever richer core.
// --------------------------------------------------------------------------------------------
export const terraformer: Bot = (v) => {
  const c = ctx(v);
  const cfg = v.config;
  calm(c, 45, 0);
  // Guard rich worlds: garrison target grows with terraform level and with contest.
  for (const w of c.mine) {
    const want = 1 + Math.floor(w.terraformLevel / 2) + (isContested(v.worlds, v.adj, w) ? 2 : 0);
    if (w.garrison < want && c.bank > cfg.garrisonCost + 20) push(c, 'garrison', w.id, cfg.garrisonCost);
  }
  claimBest(c, (w) => w.yield / claimCostOf(cfg, v.worlds, w), 5, 1, 3);
  // Terraform the best world that will still pay back before the season ends.
  const payback = cfg.terraformCost / cfg.terraformStep;
  const tf = c.mine
    .filter((w) => w.yield + cfg.terraformStep <= w.baseYield * cfg.terraformCap && w.unrest < 50)
    .sort((a, b) => b.baseYield - a.baseYield || a.id - b.id);
  if (c.remaining > payback * 1.2) {
    for (const w of tf) {
      if (c.bank < cfg.terraformCost + 10) break;
      push(c, 'terraform', w.id, cfg.terraformCost);
    }
  }
  return c.out;
};

// --------------------------------------------------------------------------------------------
// Prospector: run for the empty edge, chart everything first, stay cheap.
// --------------------------------------------------------------------------------------------
export const prospector: Bot = (v) => {
  const c = ctx(v);
  const cfg = v.config;
  calm(c, 55, 5);
  // Chart reachable sectors nobody (or not me) has charted, outer rings first.
  const near = hopsFromOwned(v.worlds, v.adj, v.me, cfg.chartRange);
  const bySector = new Map<number, World>();
  for (const id of near.keys()) {
    const w = v.worlds[id]!;
    const ch = v.charts[w.sector];
    if (ch && ch.charted.includes(v.me)) continue;
    if (!bySector.has(w.sector)) bySector.set(w.sector, w);
  }
  const sectors = [...bySector.values()].sort((a, b) => {
    const fa = v.charts[a.sector] ? 0 : 1;
    const fb = v.charts[b.sector] ? 0 : 1;
    return fb - fa || b.ring - a.ring || a.id - b.id;
  });
  for (const w of sectors) {
    if (v.charts[w.sector] && (cfg.chartReward[w.ring] ?? 0) * cfg.lateChartShare < chartCostOf(cfg, v.worlds, w)) continue;
    push(c, 'chart', w.id, chartCostOf(cfg, v.worlds, w));
  }
  // Claim outward: favour outer rings, sectors I charted first, and empty sectors.
  claimBest(
    c,
    (w) => {
      const first = v.charts[w.sector]?.first === v.me ? 1.4 : 1;
      return ((w.yield * (1 + 0.25 * w.ring)) / claimCostOf(cfg, v.worlds, w)) * first;
    },
    5,
    3,
    2.2,
  );
  return c.out;
};

// --------------------------------------------------------------------------------------------
// Raider: a small, hard base and a lot of raids on whoever is richest within reach.
// --------------------------------------------------------------------------------------------
export const raider: Bot = (v) => {
  const c = ctx(v);
  const cfg = v.config;
  calm(c, 50, 0);
  const home = c.mine[0];
  if (home && home.garrison < 3 && c.bank > cfg.garrisonCost + cfg.raidCost) push(c, 'garrison', home.id, cfg.garrisonCost);
  // Raid targets: worlds within range, by expected take, leader preferred.
  const near = hopsFromOwned(v.worlds, v.adj, v.me, cfg.raidRange);
  const cands: { type: 'raid' | 'raidLane'; target: number; s: number }[] = [];
  for (const id of near.keys()) {
    const w = v.worlds[id]!;
    if (w.owner === null || w.owner === v.me) continue;
    const p = cfg.raidPower / (cfg.raidPower + w.garrison);
    const window = Math.min(cfg.raidWindow, v.tick - w.lastRaidTick);
    const stock = cfg.raidBankShare * Math.max(0, v.players[w.owner]!.bank);
    cands.push({ type: 'raid', target: id, s: p * (cfg.raidShare * w.yield * window + stock) * leaderMult(v, w.owner) });
    for (const n of v.adj[id]!) {
      const o = v.worlds[n]!;
      if (n < id || o.owner !== w.owner) continue;
      const li = v.laneIndex[laneKey(id, n)]!;
      if (v.lanes[li]!.cutUntil > v.tick) continue;
      const lp = cfg.raidPower / (cfg.raidPower + Math.max(w.garrison, o.garrison));
      const lw = Math.min(cfg.raidWindow, v.tick - Math.max(w.lastRaidTick, o.lastRaidTick));
      cands.push({ type: 'raidLane', target: li, s: lp * (cfg.laneRaidShare * (w.yield + o.yield) * lw + stock) * leaderMult(v, w.owner) });
    }
  }
  cands.sort((a, b) => b.s - a.s || a.target - b.target);
  const used = new Set<number>();
  for (const x of cands) {
    if (x.s < cfg.raidCost * 1.5) break;
    const key = x.type === 'raid' ? x.target : -1 - x.target;
    if (used.has(key)) continue;
    if (push(c, x.type, x.target, cfg.raidCost)) used.add(key);
  }
  // A few worlds of its own, stepping toward the richest neighbours so they come into range.
  const dist = distToEnemy(v);
  if (c.mine.length < 8) claimBest(c, (w) => ((w.yield + 1) * (1 + 3 / (1 + (dist.get(w.id) ?? 9)))) / claimCostOf(cfg, v.worlds, w), 10, 1, 3);
  return c.out;
};

export const BOTS: Record<Strategy, Bot> = { scorcher, terraformer, prospector, raider };
