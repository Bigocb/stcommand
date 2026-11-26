// Dominion API balance simulation: the rules engine.
//
// Pure and deterministic. All randomness comes from a seeded generator whose state lives in
// the game state, so the same seed and the same actions always give the same season.
// `step(state, actions)` never changes its input; it returns the next state.

// ---------------------------------------------------------------------------------------------
// Tunable numbers. Every knob the balance depends on lives here.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  // Season
  seasonLength: 168, // ticks per season (one tick = one hour, so 168 = one week)
  startBank: 60, // resources each player starts (or joins late) with
  lateJoinGrant: 40, // extra resources a late joiner gets per tick of lateness (0 = none; a catch-up knob). 0 -> 40 on 2026-11-26 (report: late mean rank 3.65 -> about 2.6)
  rings: 4, // regions from core (0) to edge (rings - 1)

  // Command bandwidth: actions per tick = base + k * holdings^exponent - upkeepBw * holdings
  bandwidthBase: 3, // every player gets this much, whatever they hold (the newcomer floor's source)
  bandwidthK: 1.5, // how much holdings add
  bandwidthExponent: 0.5, // 0.5 = square root: doubling an empire gives ~41% more on the k term
  bandwidthFloor: 2, // net bandwidth never falls below this (newcomer floor)

  // Upkeep, per held world per tick
  upkeepBw: 0.35, // bandwidth each held world costs
  upkeepRes: 1.0, // resources each held world costs
  laneUpkeepRes: 0.1, // resources each held lane costs (a lane is held when you own both ends)
  garrisonUpkeep: 0.08, // resources per garrison unit per tick
  contestedMult: 1.8, // upkeep multiplier on a world next to another player's world
  // Comeback knobs (added 2026-11-26; 0 = off, the behaviour before)
  upkeepScaleRef: 6, // progressive upkeep: holdings above this many worlds ...
  upkeepScaleExp: 0, // ... raise every world's upkeep by (holdings / ref)^this (0 = flat upkeep)
  leaderUpkeepMult: 0.5, // the leader (most "power") pays this much extra upkeep, as a share (0.5 = +50%). 0 -> 0.5 on 2026-11-26 (comeback.md: leader@25% wins 48% -> 34%)
  edgeLateYield: 0, // edge-ring output rises linearly to (1 + this) by season end: a late frontier boom
  debtUnrest: 4, // unrest added to every world per tick while the bank is below zero (debt is kept and repaid from income)

  // Costs of actions (bandwidth per action)
  actionBw: { claim: 1, attack: 2, strip: 1, terraform: 1, garrison: 1, chart: 1, raid: 1, raidLane: 1, abandon: 0 } as Record<
    ActionType,
    number
  >,
  claimCost: 14, // resources to claim an unowned world (before region and sparseness multipliers)
  ringCostMult: [1.6, 1.25, 1.0, 0.7], // claim cost multiplier by ring, core to edge
  sparseDiscount: 0.4, // up to 40% off actions in a sector nobody holds (scales with how empty it is)

  // Yield
  ringYield: [5, 4, 3, 2], // mean base yield per ring, core to edge
  yieldJitter: 0.4, // +-40% random spread on base yield
  edgeExoticYield: 1.2, // extra edge-only resource yield on edge-ring worlds
  laneBonus: 0.05, // +5% output per held, uncut lane touching the world
  laneBonusCap: 0.2, // at most +20% from lanes
  minYieldFrac: 0.15, // stripping never takes a world below this share of its base yield

  // Stripping (scorcher)
  stripBurst: 8, // a strip pays this many ticks of the world's current yield at once
  stripDecay: 0.12, // and cuts the world's yield by this share, for the rest of the season. 0.2 -> 0.12 on 2026-11-26 (a scorcher buff)
  stripUnrest: 14, // unrest added by a strip ...
  thinGarrisonUnrest: 1.0, // ... times (1 + this / (1 + garrison)): thin garrisons riot more
  scorchedEarth: true, // a defender losing a world strips it on the way out
  scorchShare: 0.6, // the defender keeps this share of a strip burst when scorching

  // Unrest
  baseUnrest: 0.5, // unrest per tick on a world you claimed peacefully
  occupationUnrest: 2.0, // unrest per tick on a world you conquered
  garrisonCalm: 0.6, // unrest removed per tick per garrison unit
  unrestOutputCut: 0.7, // at 100 unrest output is cut by 70% (linear)
  revoltAt: 100, // unrest at which the world throws you out and becomes unowned
  captureUnrest: 30, // starting unrest on a conquered world

  // Terraforming
  terraformCost: 30, // resources per terraform action
  terraformStep: 0.4, // yield added per action, kept for the rest of the season. 0.6 -> 0.4 on 2026-11-26 (report: terraformer wins 50% -> 33%)
  terraformCap: 3, // a world's yield can reach at most this multiple of its base yield

  // Garrison
  garrisonCost: 8,
  garrisonMax: 10,

  // Combat
  attackCost: 25,
  attackPower: 4, // win chance = attackPower / (attackPower + garrison + 1)

  // Raids
  raidCost: 5,
  raidPower: 3, // success chance = raidPower / (raidPower + garrison)
  raidShare: 0.5, // a raid takes this share of the world's output since its last raid (the victim can go into debt) ...
  raidWindow: 8, // ... counting at most this many ticks ...
  raidBankShare: 0.01, // ... plus this share of the victim's bank (their stock), if it is positive
  raidRange: 2, // lane hops from one of your worlds
  raidUnrest: 4, // unrest a raid leaves on the target
  laneCutTicks: 6, // a lane raid cuts the lane for this long
  laneRaidShare: 0.3, // and takes this share of both ends' output over the same window

  // Frontier and charting (prospector)
  firstChartPremium: 1.7, // output multiplier for the first charter of a sector ...
  premiumHours: 36, // ... fading to 1 over this many ticks ...
  // ... and divided down as others arrive: premium = 1 + 0.7 * fade / (1 + other holders in sector)
  chartCost: 3,
  chartReward: [0, 0, 10, 25], // one-off reward for the first charter, by ring
  lateChartShare: 0.2, // later charters get this share of the reward
  chartRange: 2, // lane hops from one of your worlds

  // Weight on the leader
  leaderWeight: 1, // 0 = none. Scales hostile events on the leader and bots' preference to raid them
  leaderEventRate: 0.12, // per tick chance of a hostile event on the leader, times leaderWeight
  leaderEventUnrest: 18, // unrest the event adds to one of the leader's worlds
  leaderEventGarrisonLoss: 1, // garrison the event kills there
  leaderIncomeTicks: 24, // "power" (who leads) = bank + this many ticks of current yield

  // Intel
  intelDelay: 3, // ticks of delay on what a bot sees of other players
};

export type Config = typeof DEFAULT_CONFIG;
export type ActionType = 'claim' | 'attack' | 'strip' | 'terraform' | 'garrison' | 'chart' | 'raid' | 'raidLane' | 'abandon';
export type Strategy = 'scorcher' | 'terraformer' | 'prospector' | 'raider';
export const STRATEGIES: Strategy[] = ['scorcher', 'terraformer', 'prospector', 'raider'];

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides, actionBw: { ...DEFAULT_CONFIG.actionBw, ...(overrides.actionBw ?? {}) } };
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface World {
  id: number;
  ring: number; // 0 = core ... rings-1 = edge
  sector: number; // global sector id (rings are cut into angular sectors)
  x: number;
  y: number;
  baseYield: number;
  yield: number;
  owner: number | null;
  garrison: number;
  unrest: number;
  captured: boolean; // taken by force (occupation unrest applies)
  terraformLevel: number;
  stripCount: number;
  lastRaidTick: number;
  lastOutput: number;
}

export interface Lane {
  a: number;
  b: number;
  cutUntil: number;
}

export interface Player {
  id: number;
  strategy: Strategy;
  bank: number;
  joinTick: number;
  startRing: number;
  homeWorld: number; // preferred home, resolved at join
  joined: boolean;
  carry: number; // fractional bandwidth carried to next tick
  scorch: boolean; // strips a world it is about to lose
  // counters for the report
  stripped: number;
  raidsWon: number;
  stolen: number;
  lostWorlds: number;
}

export interface SectorChart {
  first: number;
  tick: number;
  charted: number[]; // every player who has charted it
}

export interface State {
  tick: number;
  rng: number;
  config: Config;
  worlds: World[];
  lanes: Lane[];
  adj: number[][]; // world id -> neighbouring world ids
  laneIndex: Record<string, number>; // "a-b" (a<b) -> lane index
  sectorRing: number[]; // sector id -> ring
  players: Player[];
  charts: Record<number, SectorChart>;
  leaderEvents: number;
}

export interface Action {
  player: number;
  type: ActionType;
  target: number; // world id, or lane index for raidLane
}

// ---------------------------------------------------------------------------------------------
// Seeded RNG (mulberry32). The state is a plain number so it can live in the game state.
// ---------------------------------------------------------------------------------------------

export function rngNext(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}

/** A small stateful wrapper for code outside `step` (map generation, bots). */
export class Rng {
  constructor(public s: number) {}
  next(): number {
    const [v, s] = rngNext(this.s);
    this.s = s;
    return v;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: T[]): T {
    return xs[this.int(xs.length)]!;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (also used by bots on their stale view)
// ---------------------------------------------------------------------------------------------

/** Gross bandwidth before upkeep: base + k * holdings^exponent. */
export function grossBandwidth(cfg: Config, holdings: number): number {
  return cfg.bandwidthBase + cfg.bandwidthK * Math.pow(Math.max(0, holdings), cfg.bandwidthExponent);
}

/** Net actions available per tick after bandwidth upkeep, never below the floor. */
export function netBandwidth(cfg: Config, holdings: number, contested = 0): number {
  const upkeep = cfg.upkeepBw * (holdings - contested + contested * cfg.contestedMult);
  return Math.max(cfg.bandwidthFloor, grossBandwidth(cfg, holdings) - upkeep);
}

export interface WorldLike {
  id: number;
  ring: number;
  sector: number;
  owner: number | null;
}

/** Share of a sector's worlds that anyone holds (0 = empty frontier). */
export function sectorDensity(worlds: WorldLike[], sector: number): number {
  let n = 0;
  let held = 0;
  for (const w of worlds) {
    if (w.sector !== sector) continue;
    n++;
    if (w.owner !== null) held++;
  }
  return n === 0 ? 0 : held / n;
}

/** Cost multiplier for acting in a sector: cheaper where it is sparsely held. */
export function sparseMult(cfg: Config, worlds: WorldLike[], sector: number): number {
  return 1 - cfg.sparseDiscount * (1 - sectorDensity(worlds, sector));
}

export function claimCostOf(cfg: Config, worlds: WorldLike[], w: WorldLike): number {
  return cfg.claimCost * (cfg.ringCostMult[w.ring] ?? 1) * sparseMult(cfg, worlds, w.sector);
}

export function chartCostOf(cfg: Config, worlds: WorldLike[], w: WorldLike): number {
  return cfg.chartCost * sparseMult(cfg, worlds, w.sector);
}

export function isContested(worlds: WorldLike[], adj: number[][], w: WorldLike): boolean {
  if (w.owner === null) return false;
  for (const n of adj[w.id] ?? []) {
    const o = worlds[n]!.owner;
    if (o !== null && o !== w.owner) return true;
  }
  return false;
}

/** Lane-hop distance from any world owned by `player` (BFS), up to maxHops. */
export function hopsFromOwned(worlds: WorldLike[], adj: number[][], player: number, maxHops: number): Map<number, number> {
  const dist = new Map<number, number>();
  let frontier: number[] = [];
  for (const w of worlds) {
    if (w.owner === player) {
      dist.set(w.id, 0);
      frontier.push(w.id);
    }
  }
  for (let d = 1; d <= maxHops; d++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const n of adj[id] ?? []) {
        if (!dist.has(n)) {
          dist.set(n, d);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

export function laneKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Power: bank plus `leaderIncomeTicks` ticks of current yield. This is how players (and the
 * leader-weight rule) judge who is ahead mid-season; a terraformer with an empty bank and rich
 * worlds is still the leader. The season itself is won on the bank alone.
 */
export function powerOf(cfg: Config, worlds: { owner: number | null; yield: number }[], player: { id: number; bank: number }): number {
  let y = 0;
  for (const w of worlds) if (w.owner === player.id) y += w.yield;
  return player.bank + cfg.leaderIncomeTicks * y;
}

export function leaderOf(
  cfg: Config,
  worlds: { owner: number | null; yield: number }[],
  players: { id: number; bank: number; joined: boolean }[],
): number | null {
  let best: number | null = null;
  let bestPower = -Infinity;
  for (const p of players) {
    if (!p.joined) continue;
    const pw = powerOf(cfg, worlds, p);
    if (pw > bestPower) {
      bestPower = pw;
      best = p.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Map generation
// ---------------------------------------------------------------------------------------------

export interface MapOptions {
  worldCount: number; // 40-80 is the intended range
}

const RING_SHARE = [0.15, 0.25, 0.3, 0.3];
const RING_SECTORS = [1, 3, 4, 5];

export function generateMap(seed: number, cfg: Config, opts: MapOptions): Pick<State, 'worlds' | 'lanes' | 'adj' | 'laneIndex' | 'sectorRing'> {
  const rng = new Rng(seed);
  const worlds: World[] = [];
  const sectorRing: number[] = [];
  const sectorBase: number[] = [];
  for (let r = 0; r < cfg.rings; r++) {
    sectorBase.push(sectorRing.length);
    for (let s = 0; s < (RING_SECTORS[r] ?? 4); s++) sectorRing.push(r);
  }
  let id = 0;
  for (let r = 0; r < cfg.rings; r++) {
    const n = r === cfg.rings - 1 ? opts.worldCount - id : Math.round(opts.worldCount * (RING_SHARE[r] ?? 0.25));
    const sectors = RING_SECTORS[r] ?? 4;
    for (let i = 0; i < n; i++) {
      const angle = rng.next() * Math.PI * 2;
      const radius = r === 0 ? rng.next() * 1.0 : r + rng.next() * 0.9;
      const sector = sectorBase[r]! + Math.min(sectors - 1, Math.floor((angle / (Math.PI * 2)) * sectors));
      const base = (cfg.ringYield[r] ?? 2) * (1 + (rng.next() * 2 - 1) * cfg.yieldJitter) + (r === cfg.rings - 1 ? cfg.edgeExoticYield : 0);
      worlds.push({
        id,
        ring: r,
        sector,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        baseYield: base,
        yield: base,
        owner: null,
        garrison: 0,
        unrest: 0,
        captured: false,
        terraformLevel: 0,
        stripCount: 0,
        lastRaidTick: 0,
        lastOutput: 0,
      });
      id++;
    }
  }
  // Lanes: each world links to its nearest 2 (3 in the core) neighbours, then components are joined.
  const keys = new Set<string>();
  const lanes: Lane[] = [];
  const addLane = (a: number, b: number) => {
    const k = laneKey(a, b);
    if (a === b || keys.has(k)) return;
    keys.add(k);
    lanes.push({ a: Math.min(a, b), b: Math.max(a, b), cutUntil: 0 });
  };
  const d2 = (a: World, b: World) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  for (const w of worlds) {
    const near = worlds.filter((o) => o.id !== w.id).sort((a, b) => d2(w, a) - d2(w, b) || a.id - b.id);
    const k = w.ring === 0 ? 3 : 2;
    for (let i = 0; i < k && i < near.length; i++) addLane(w.id, near[i]!.id);
  }
  for (;;) {
    const comp = components(worlds.length, lanes);
    if (comp.count === 1) break;
    // join component 0 to its nearest other component
    let best: [number, number, number] | null = null;
    for (const a of worlds) {
      if (comp.of[a.id] !== 0) continue;
      for (const b of worlds) {
        if (comp.of[b.id] === 0) continue;
        const d = d2(a, b);
        if (!best || d < best[2]) best = [a.id, b.id, d];
      }
    }
    addLane(best![0], best![1]);
  }
  const adj: number[][] = worlds.map(() => []);
  const laneIndex: Record<string, number> = {};
  lanes.forEach((l, i) => {
    adj[l.a]!.push(l.b);
    adj[l.b]!.push(l.a);
    laneIndex[laneKey(l.a, l.b)] = i;
  });
  for (const a of adj) a.sort((x, y) => x - y);
  return { worlds, lanes, adj, laneIndex, sectorRing };
}

function components(n: number, lanes: Lane[]): { count: number; of: number[] } {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const l of lanes) parent[find(l.a)] = find(l.b);
  const ids = new Map<number, number>();
  const of = parent.map((_, i) => {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r)!;
  });
  // make sure the component holding world 0 is numbered 0
  return { count: ids.size, of };
}

export interface PlayerSetup {
  strategy: Strategy;
  startRing: number;
  joinTick: number;
}

/** Build a fresh season: map plus players with spread-out home worlds in their start rings. */
export function newGame(seed: number, mapSeed: number, cfg: Config, opts: MapOptions, setups: PlayerSetup[]): State {
  const map = generateMap(mapSeed, cfg, opts);
  const rng = new Rng(seed ^ 0x5bd1e995);
  const homes: number[] = [];
  const players: Player[] = setups.map((s, i) => {
    const ringWorlds = map.worlds.filter((w) => w.ring === s.startRing && !homes.includes(w.id));
    let pick = ringWorlds[0]!;
    let bestScore = -Infinity;
    for (const w of ringWorlds) {
      const minD = homes.length === 0 ? 0 : Math.min(...homes.map((h) => Math.hypot(map.worlds[h]!.x - w.x, map.worlds[h]!.y - w.y)));
      const score = minD + rng.next() * 0.8;
      if (score > bestScore) {
        bestScore = score;
        pick = w;
      }
    }
    homes.push(pick.id);
    return {
      id: i,
      strategy: s.strategy,
      bank: cfg.startBank,
      joinTick: s.joinTick,
      startRing: s.startRing,
      homeWorld: pick.id,
      joined: false,
      carry: 0,
      scorch: true,
      stripped: 0,
      raidsWon: 0,
      stolen: 0,
      lostWorlds: 0,
    };
  });
  return { tick: 0, rng: seed >>> 0, config: cfg, ...map, players, charts: {}, leaderEvents: 0 };
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

/** Bandwidth a player can spend this tick (whole actions), from the true state. */
export function budgetOf(s: State, playerId: number): number {
  const p = s.players[playerId]!;
  if (!p.joined && p.joinTick > s.tick) return 0;
  const owned = s.worlds.filter((w) => w.owner === playerId);
  const contested = owned.filter((w) => isContested(s.worlds, s.adj, w)).length;
  const holdings = p.joined ? owned.length : 1;
  return Math.floor(netBandwidth(s.config, holdings, contested) + p.carry);
}

export function step(prev: State, actions: Action[]): State {
  const s: State = structuredClone(prev);
  const cfg = s.config;
  const t = s.tick;
  const rand = () => {
    const [v, n] = rngNext(s.rng);
    s.rng = n;
    return v;
  };

  // 1. Joins: a player arriving this tick takes its home world, or the nearest free one in its ring.
  for (const p of s.players) {
    if (p.joined || p.joinTick > t) continue;
    p.joined = true;
    let home = s.worlds[p.homeWorld]!;
    if (home.owner !== null) {
      const free = s.worlds.filter((w) => w.owner === null && w.ring === p.startRing);
      const pool = free.length ? free : s.worlds.filter((w) => w.owner === null);
      if (pool.length === 0) continue;
      pool.sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y) || a.id - b.id);
      home = pool[0]!;
    }
    p.bank += cfg.lateJoinGrant * p.joinTick;
    home.owner = p.id;
    home.garrison = 2;
    home.unrest = 0;
    home.captured = false;
    p.homeWorld = home.id;
  }

  // 2. Actions: each player's list is cut to its bandwidth, then lists are interleaved
  //    round-robin in a random player order so conflicts (two claims on one world) are fair.
  const queues: Action[][] = s.players.map(() => []);
  for (const p of s.players) {
    if (!p.joined) continue;
    const budget = budgetOf(s, p.id);
    const avail = budget + 0; // budgetOf already includes the carried fraction
    let spent = 0;
    for (const a of actions) {
      if (a.player !== p.id) continue;
      const cost = cfg.actionBw[a.type] ?? 1;
      if (spent + cost > avail) break;
      spent += cost;
      queues[p.id]!.push(a);
    }
    const owned = s.worlds.filter((w) => w.owner === p.id).length;
    const contested = s.worlds.filter((w) => w.owner === p.id && isContested(s.worlds, s.adj, w)).length;
    const raw = netBandwidth(cfg, owned, contested) + p.carry;
    p.carry = raw - Math.floor(raw);
  }
  const order = s.players.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const maxLen = Math.max(0, ...queues.map((q) => q.length));
  for (let i = 0; i < maxLen; i++) {
    for (const pid of order) {
      const a = queues[pid]![i];
      if (a) resolveAction(s, a, rand);
    }
  }

  // 3. Income.
  const holdersBySector = new Map<number, Set<number>>();
  for (const w of s.worlds) {
    if (w.owner === null) continue;
    if (!holdersBySector.has(w.sector)) holdersBySector.set(w.sector, new Set());
    holdersBySector.get(w.sector)!.add(w.owner);
  }
  for (const w of s.worlds) {
    w.lastOutput = 0;
    if (w.owner === null) continue;
    const p = s.players[w.owner]!;
    let intact = 0;
    for (const n of s.adj[w.id]!) {
      if (s.worlds[n]!.owner !== w.owner) continue;
      const lane = s.lanes[s.laneIndex[laneKey(w.id, n)]!]!;
      if (lane.cutUntil <= t) intact++;
    }
    const laneMult = 1 + Math.min(cfg.laneBonusCap, cfg.laneBonus * intact);
    const unrestMult = 1 - cfg.unrestOutputCut * (w.unrest / 100);
    const edgeMult = w.ring === cfg.rings - 1 ? 1 + cfg.edgeLateYield * (t / cfg.seasonLength) : 1;
    const out = w.yield * laneMult * unrestMult * edgeMult * chartPremium(s, w, holdersBySector);
    w.lastOutput = out;
    p.bank += out;
  }

  // 4. Upkeep.
  const upkeepLeader = cfg.leaderUpkeepMult > 0 ? leaderOf(cfg, s.worlds, s.players) : null;
  for (const p of s.players) {
    if (!p.joined) continue;
    let cost = 0;
    let held = 0;
    for (const w of s.worlds) if (w.owner === p.id) held++;
    const scale = cfg.upkeepScaleExp > 0 ? Math.pow(Math.max(1, held / cfg.upkeepScaleRef), cfg.upkeepScaleExp) : 1;
    const leaderMult = upkeepLeader === p.id ? 1 + cfg.leaderUpkeepMult : 1;
    for (const w of s.worlds) {
      if (w.owner !== p.id) continue;
      const mult = isContested(s.worlds, s.adj, w) ? cfg.contestedMult : 1;
      cost += cfg.upkeepRes * mult * scale * leaderMult + cfg.garrisonUpkeep * w.garrison;
    }
    for (const l of s.lanes) {
      if (s.worlds[l.a]!.owner === p.id && s.worlds[l.b]!.owner === p.id) cost += cfg.laneUpkeepRes;
    }
    p.bank -= cost;
    if (p.bank < 0) {
      for (const w of s.worlds) if (w.owner === p.id) w.unrest += cfg.debtUnrest;
    }
  }

  // 5. Weight on the leader: hostile events land on the player with the most resources.
  const leader = leaderOf(cfg, s.worlds, s.players);
  if (leader !== null && cfg.leaderWeight > 0 && rand() < Math.min(1, cfg.leaderEventRate * cfg.leaderWeight)) {
    const owned = s.worlds.filter((w) => w.owner === leader);
    if (owned.length) {
      const w = owned[Math.floor(rand() * owned.length)]!;
      w.unrest += cfg.leaderEventUnrest;
      w.garrison = Math.max(0, w.garrison - cfg.leaderEventGarrisonLoss);
      s.leaderEvents++;
    }
  }

  // 6. Unrest and revolts.
  for (const w of s.worlds) {
    if (w.owner === null) continue;
    const drift = (w.captured ? cfg.occupationUnrest : cfg.baseUnrest) - cfg.garrisonCalm * w.garrison;
    w.unrest = Math.min(100, Math.max(0, w.unrest + drift));
    if (w.unrest >= cfg.revoltAt) {
      s.players[w.owner]!.lostWorlds++;
      w.owner = null;
      w.garrison = 0;
      w.unrest = 0;
      w.captured = false;
    }
  }

  s.tick = t + 1;
  return s;
}

/** Output multiplier from being first to chart a sector: 1.7x fading over premiumHours and with company. */
export function chartPremium(s: State, w: World, holdersBySector?: Map<number, Set<number>>): number {
  const c = s.charts[w.sector];
  if (!c || c.first !== w.owner) return 1;
  const fade = Math.max(0, 1 - (s.tick - c.tick) / s.config.premiumHours);
  let others = 0;
  if (holdersBySector) {
    others = Math.max(0, (holdersBySector.get(w.sector)?.size ?? 1) - 1);
  } else {
    const set = new Set(s.worlds.filter((x) => x.sector === w.sector && x.owner !== null && x.owner !== w.owner).map((x) => x.owner));
    others = set.size;
  }
  return 1 + ((s.config.firstChartPremium - 1) * fade) / (1 + others);
}

function resolveAction(s: State, a: Action, rand: () => number): void {
  const cfg = s.config;
  const p = s.players[a.player]!;
  const t = s.tick;
  const owned = (w: World) => w.owner === p.id;
  const ownsAny = s.worlds.some(owned);
  const adjacentToOwn = (id: number) => s.adj[id]!.some((n) => s.worlds[n]!.owner === p.id);

  if (a.type === 'raidLane') {
    const lane = s.lanes[a.target];
    if (!lane || p.bank < cfg.raidCost) return;
    const A = s.worlds[lane.a]!;
    const B = s.worlds[lane.b]!;
    if (A.owner === null || A.owner !== B.owner || A.owner === p.id || lane.cutUntil > t) return;
    const near = hopsFromOwned(s.worlds, s.adj, p.id, cfg.raidRange);
    if (!near.has(A.id) && !near.has(B.id)) return;
    p.bank -= cfg.raidCost;
    const g = Math.max(A.garrison, B.garrison);
    if (rand() >= cfg.raidPower / (cfg.raidPower + g)) return;
    lane.cutUntil = t + cfg.laneCutTicks;
    const victim = s.players[A.owner]!;
    const window = Math.min(cfg.raidWindow, t - Math.max(A.lastRaidTick, B.lastRaidTick));
    const take = cfg.laneRaidShare * (A.yield + B.yield) * Math.max(0, window) + cfg.raidBankShare * Math.max(0, victim.bank);
    A.lastRaidTick = B.lastRaidTick = t;
    victim.bank -= take;
    p.bank += take;
    p.raidsWon++;
    p.stolen += take;
    return;
  }

  const w = s.worlds[a.target];
  if (!w) return;
  switch (a.type) {
    case 'claim': {
      if (w.owner !== null) return;
      if (ownsAny ? !adjacentToOwn(w.id) : w.ring !== cfg.rings - 1) return; // a player with nothing restarts at the edge
      const cost = claimCostOf(cfg, s.worlds, w);
      if (p.bank < cost) return;
      p.bank -= cost;
      w.owner = p.id;
      w.garrison = 0;
      w.unrest = 0;
      w.captured = false;
      return;
    }
    case 'attack': {
      if (w.owner === null || w.owner === p.id || !adjacentToOwn(w.id)) return;
      if (p.bank < cfg.attackCost) return;
      p.bank -= cfg.attackCost;
      if (rand() >= cfg.attackPower / (cfg.attackPower + w.garrison + 1)) {
        w.garrison = Math.max(0, w.garrison - 1);
        return;
      }
      const def = s.players[w.owner]!;
      if (cfg.scorchedEarth && def.scorch) {
        def.bank += cfg.stripBurst * w.yield * cfg.scorchShare;
        w.yield = Math.max(w.baseYield * cfg.minYieldFrac, w.yield * (1 - cfg.stripDecay));
        w.stripCount++;
        def.stripped++;
      }
      def.lostWorlds++;
      w.owner = p.id;
      w.garrison = 1;
      w.unrest = cfg.captureUnrest;
      w.captured = true;
      return;
    }
    case 'strip': {
      if (!owned(w)) return;
      p.bank += cfg.stripBurst * w.yield;
      w.yield = Math.max(w.baseYield * cfg.minYieldFrac, w.yield * (1 - cfg.stripDecay));
      w.unrest += cfg.stripUnrest * (1 + cfg.thinGarrisonUnrest / (1 + w.garrison));
      w.stripCount++;
      p.stripped++;
      return;
    }
    case 'terraform': {
      if (!owned(w) || p.bank < cfg.terraformCost) return;
      if (w.yield >= w.baseYield * cfg.terraformCap) return;
      p.bank -= cfg.terraformCost;
      w.yield = Math.min(w.baseYield * cfg.terraformCap, w.yield + cfg.terraformStep);
      w.terraformLevel++;
      return;
    }
    case 'abandon': {
      // Let a world go (it becomes unowned, keeping whatever damage was done to it).
      if (!owned(w)) return;
      w.owner = null;
      w.garrison = 0;
      w.unrest = 0;
      w.captured = false;
      return;
    }
    case 'garrison': {
      if (!owned(w) || p.bank < cfg.garrisonCost || w.garrison >= cfg.garrisonMax) return;
      p.bank -= cfg.garrisonCost;
      w.garrison++;
      return;
    }
    case 'chart': {
      const c = s.charts[w.sector];
      if (c && c.charted.includes(p.id)) return;
      const near = hopsFromOwned(s.worlds, s.adj, p.id, cfg.chartRange);
      if (!near.has(w.id)) return;
      const cost = chartCostOf(cfg, s.worlds, w);
      if (p.bank < cost) return;
      p.bank -= cost;
      const reward = cfg.chartReward[w.ring] ?? 0;
      if (!c) {
        s.charts[w.sector] = { first: p.id, tick: t, charted: [p.id] };
        p.bank += reward;
      } else {
        c.charted.push(p.id);
        p.bank += reward * cfg.lateChartShare;
      }
      return;
    }
    case 'raid': {
      if (w.owner === null || w.owner === p.id || p.bank < cfg.raidCost) return;
      const near = hopsFromOwned(s.worlds, s.adj, p.id, cfg.raidRange);
      if (!near.has(w.id)) return;
      p.bank -= cfg.raidCost;
      if (rand() >= cfg.raidPower / (cfg.raidPower + w.garrison)) return;
      const victim = s.players[w.owner]!;
      const window = Math.min(cfg.raidWindow, t - w.lastRaidTick);
      const take = cfg.raidShare * w.yield * Math.max(0, window) + cfg.raidBankShare * Math.max(0, victim.bank);
      w.lastRaidTick = t;
      w.unrest += cfg.raidUnrest;
      victim.bank -= take;
      p.bank += take;
      p.raidsWon++;
      p.stolen += take;
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stale intel: what one player sees
// ---------------------------------------------------------------------------------------------

export interface View {
  tick: number;
  me: number;
  config: Config;
  worlds: World[]; // own worlds current, everyone else's as of `intelDelay` ticks ago
  lanes: Lane[];
  adj: number[][];
  laneIndex: Record<string, number>;
  players: { id: number; strategy: Strategy; bank: number; joined: boolean }[];
  charts: Record<number, SectorChart>; // charts are public and current
  myBank: number;
  budget: number;
  leader: number | null; // as of the stale view
}

/** Build a player's view from the current state and the state `intelDelay` ticks ago. */
export function makeView(now: State, delayed: State, me: number): View {
  const worlds = now.worlds.map((w, i) => {
    const old = delayed.worlds[i]!;
    if (w.owner === me) return { ...w };
    if (old.owner === me) return { ...old, owner: w.owner }; // you know you lost it
    return { ...old };
  });
  const players = now.players.map((p, i) => ({
    id: p.id,
    strategy: p.strategy,
    bank: p.id === me ? p.bank : delayed.players[i]!.bank,
    joined: p.id === me ? p.joined || p.joinTick <= now.tick : delayed.players[i]!.joined,
  }));
  return {
    tick: now.tick,
    me,
    config: now.config,
    worlds,
    lanes: now.lanes.map((l) => ({ ...l })),
    adj: now.adj,
    laneIndex: now.laneIndex,
    players,
    charts: now.charts,
    myBank: now.players[me]!.bank,
    budget: budgetOf(now, me),
    leader: leaderOf(now.config, worlds, players),
  };
}
