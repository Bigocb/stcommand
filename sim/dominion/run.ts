// Dominion API balance simulation: the runner.
//
//   node --import tsx sim/dominion/run.ts [--seasons 200] [--sweep 100] [--out sim/dominion/report.md]
//
// Runs many seasons across map seeds, world counts, start positions and late starters, then
// writes a markdown report and prints a short summary.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS } from './bots.ts';
import {
  type Action,
  type Config,
  type PlayerSetup,
  type State,
  type Strategy,
  Rng,
  STRATEGIES,
  leaderOf,
  makeConfig,
  makeView,
  newGame,
  step,
} from './rules.ts';

// --------------------------------------------------------------------------------------------
// One season
// --------------------------------------------------------------------------------------------

export interface SeasonSpec {
  index: number;
  seed: number;
  mapSeed: number;
  worldCount: number;
  setups: PlayerSetup[];
  lateStarter: number | null; // player id that joins late, if any
}

export interface SeasonResult {
  spec: SeasonSpec;
  banks: number[];
  ranks: number[]; // rank per player id, 1 = winner
  winner: number;
  winnerStrategy: Strategy;
  leaderAt25: number | null;
  leaderAt50: number | null;
  worldsHeld: number[];
  leaderEvents: number;
}

export function runSeason(spec: SeasonSpec, cfg: Config): SeasonResult {
  let now: State = newGame(spec.seed, spec.mapSeed, cfg, { worldCount: spec.worldCount }, spec.setups);
  const history: State[] = [now];
  let leaderAt25: number | null = null;
  let leaderAt50: number | null = null;
  const t25 = Math.floor(cfg.seasonLength * 0.25);
  const t50 = Math.floor(cfg.seasonLength * 0.5);
  while (now.tick < cfg.seasonLength) {
    const delayed = history[Math.max(0, history.length - 1 - cfg.intelDelay)]!;
    const actions: Action[] = [];
    for (const p of now.players) {
      if (!p.joined && p.joinTick > now.tick) continue;
      actions.push(...BOTS[p.strategy](makeView(now, delayed, p.id)));
    }
    now = step(now, actions);
    history.push(now);
    if (history.length > cfg.intelDelay + 2) history.shift();
    if (now.tick === t25) leaderAt25 = leaderOf(cfg, now.worlds, now.players);
    if (now.tick === t50) leaderAt50 = leaderOf(cfg, now.worlds, now.players);
  }
  const banks = now.players.map((p) => p.bank);
  const order = now.players.map((p) => p.id).sort((a, b) => banks[b]! - banks[a]! || a - b);
  const ranks: number[] = [];
  order.forEach((id, i) => (ranks[id] = i + 1));
  const winner = order[0]!;
  return {
    spec,
    banks,
    ranks,
    winner,
    winnerStrategy: now.players[winner]!.strategy,
    leaderAt25,
    leaderAt50,
    worldsHeld: now.players.map((p) => now.worlds.filter((w) => w.owner === p.id).length),
    leaderEvents: now.leaderEvents,
  };
}

// --------------------------------------------------------------------------------------------
// The season plan: varied seeds, maps, starts and late starters
// --------------------------------------------------------------------------------------------

export const MAP_SEEDS = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010];
export const RING_NAMES = ['core', 'inner', 'outer', 'edge'];

export function planSeasons(n: number, cfg: Config, baseSeed = 7): SeasonSpec[] {
  const specs: SeasonSpec[] = [];
  for (let i = 0; i < n; i++) {
    const rng = new Rng((baseSeed * 1_000_003 + i * 7919) >>> 0);
    rng.next();
    const mapSeed = MAP_SEEDS[i % MAP_SEEDS.length]!;
    const worldCount = 40 + ((mapSeed * 37) % 41); // 40-80, fixed per map
    const setups: PlayerSetup[] = STRATEGIES.map((strategy) => ({ strategy, startRing: rng.int(cfg.rings), joinTick: 0 }));
    let lateStarter: number | null = null;
    if (rng.next() < 0.4) {
      lateStarter = rng.int(setups.length);
      setups[lateStarter]!.joinTick = Math.floor(cfg.seasonLength * (0.2 + 0.1 * rng.next()));
      setups[lateStarter]!.startRing = cfg.rings - 1;
    }
    specs.push({ index: i, seed: rng.int(2 ** 31), mapSeed, worldCount, setups, lateStarter });
  }
  return specs;
}

// --------------------------------------------------------------------------------------------
// Summaries
// --------------------------------------------------------------------------------------------

export interface Summary {
  n: number;
  wins: Record<Strategy, number>;
  share: Record<Strategy, number>;
  maxShare: number;
  dominant: Strategy;
  entropy: number; // 0 = one strategy always wins, 1 = all four win equally often
  snowball25: number; // share of seasons where the leader at 25% wins
  snowball50: number;
  lateMeanRank: number | null;
  lateTop2: number | null;
  mapsWithDifferentTop: number; // how many distinct strategies are the top winner on some map
}

export function summarize(results: SeasonResult[]): Summary {
  const wins = Object.fromEntries(STRATEGIES.map((s) => [s, 0])) as Record<Strategy, number>;
  for (const r of results) wins[r.winnerStrategy]++;
  const n = results.length;
  const share = Object.fromEntries(STRATEGIES.map((s) => [s, wins[s] / n])) as Record<Strategy, number>;
  let dominant: Strategy = STRATEGIES[0]!;
  for (const s of STRATEGIES) if (share[s] > share[dominant]) dominant = s;
  let h = 0;
  for (const s of STRATEGIES) if (share[s] > 0) h -= share[s] * Math.log(share[s]);
  const lates = results.filter((r) => r.spec.lateStarter !== null);
  const lateRanks = lates.map((r) => r.ranks[r.spec.lateStarter!]!);
  const tops = new Set<Strategy>();
  for (const m of MAP_SEEDS) {
    const rs = results.filter((r) => r.spec.mapSeed === m);
    if (rs.length === 0) continue;
    const w = summarizeWins(rs);
    tops.add(w);
  }
  return {
    n,
    wins,
    share,
    maxShare: share[dominant],
    dominant,
    entropy: h / Math.log(STRATEGIES.length),
    snowball25: results.filter((r) => r.leaderAt25 === r.winner).length / n,
    snowball50: results.filter((r) => r.leaderAt50 === r.winner).length / n,
    lateMeanRank: lateRanks.length ? lateRanks.reduce((a, b) => a + b, 0) / lateRanks.length : null,
    lateTop2: lateRanks.length ? lateRanks.filter((x) => x <= 2).length / lateRanks.length : null,
    mapsWithDifferentTop: tops.size,
  };
}

function summarizeWins(rs: SeasonResult[]): Strategy {
  const c = new Map<Strategy, number>();
  for (const r of rs) c.set(r.winnerStrategy, (c.get(r.winnerStrategy) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || STRATEGIES.indexOf(a[0]) - STRATEGIES.indexOf(b[0]))[0]![0];
}

export function runMany(n: number, cfg: Config, baseSeed = 7): SeasonResult[] {
  return planSeasons(n, cfg, baseSeed).map((s) => runSeason(s, cfg));
}

// --------------------------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number) => x.toFixed(2);

function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** Normal-approximation 95% margin on a share. */
const margin = (p: number, n: number) => 1.96 * Math.sqrt((p * (1 - p)) / Math.max(1, n));

interface SweepRow {
  knob: string;
  value: string;
  s: Summary;
}

const FIXES: Record<Strategy, { label: string; overrides: Partial<Config> }[]> = {
  scorcher: [
    { label: 'stripDecay 0.2 -> 0.35', overrides: { stripDecay: 0.35 } },
    { label: 'stripBurst 8 -> 5', overrides: { stripBurst: 5 } },
    { label: 'occupationUnrest 2 -> 3.5', overrides: { occupationUnrest: 3.5 } },
  ],
  terraformer: [
    { label: 'terraformStep 0.4 -> 0.3', overrides: { terraformStep: 0.3 } },
    { label: 'terraformCost 30 -> 45', overrides: { terraformCost: 45 } },
    { label: 'terraformCap 3 -> 2', overrides: { terraformCap: 2 } },
  ],
  prospector: [
    { label: 'firstChartPremium 1.7 -> 1.4', overrides: { firstChartPremium: 1.4 } },
    { label: 'sparseDiscount 0.4 -> 0.2', overrides: { sparseDiscount: 0.2 } },
    { label: 'edgeExoticYield 1.2 -> 0.6', overrides: { edgeExoticYield: 0.6 } },
  ],
  raider: [
    { label: 'raidShare 0.5 -> 0.3', overrides: { raidShare: 0.3 } },
    { label: 'raidPower 3 -> 2', overrides: { raidPower: 2 } },
    { label: 'raidWindow 8 -> 5', overrides: { raidWindow: 5 } },
  ],
};

/**
 * Composite balance score, the pitch's three tests in one number: varied winners (entropy),
 * an early lead that does not decide the season, and late starters who can still place.
 */
const balanceScore = (s: Summary) =>
  s.entropy -
  0.5 * Math.max(0, s.snowball25 - 0.25) -
  0.5 * Math.max(0, s.maxShare - 0.4) -
  0.2 * Math.max(0, (s.lateMeanRank ?? 2.5) - 2.5);

function main(): void {
  const args = process.argv.slice(2);
  const arg = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : def;
  };
  const N = Number(arg('seasons', '200'));
  const SWEEP_N = Number(arg('sweep', String(Math.max(40, Math.round(N / 2)))));
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = arg('out', join(here, 'report.md'));
  const t0 = Date.now();

  const cfg = makeConfig();
  const results = runMany(N, cfg);
  const S = summarize(results);
  // The defaults before 2026-11-26, on the same seeds, so the report shows what the change did.
  const PREV: Partial<Config> = { terraformStep: 0.6, lateJoinGrant: 0 };
  const prevS = summarize(runMany(N, makeConfig(PREV)));

  // ---- sensitivity sweep
  const sweeps: { knob: keyof Config; values: number[] }[] = [
    { knob: 'bandwidthExponent', values: [0.3, 0.5, 0.7, 1.0] },
    { knob: 'upkeepRes', values: [0.3, 0.6, 1.2, 2.0] },
    { knob: 'leaderWeight', values: [0, 1, 2, 4] },
    { knob: 'lateJoinGrant', values: [0, 20, 40, 60] },
  ];
  const sweepRows: SweepRow[] = [];
  for (const sw of sweeps) {
    for (const val of sw.values) {
      const c = makeConfig({ [sw.knob]: val } as Partial<Config>);
      sweepRows.push({ knob: sw.knob, value: String(val), s: summarize(runMany(SWEEP_N, c, 99)) });
    }
  }

  // ---- dominance check and fix
  const dominantFound = S.maxShare > 0.4;
  let fixRows: { label: string; s: Summary }[] = [];
  let bestFix: { label: string; overrides: Partial<Config>; s: Summary } | null = null;
  if (dominantFound) {
    const base99 = summarize(runMany(SWEEP_N, cfg, 99));
    fixRows.push({ label: 'defaults (same seeds)', s: base99 });
    for (const fx of FIXES[S.dominant]) {
      const s = summarize(runMany(SWEEP_N, makeConfig(fx.overrides), 99));
      fixRows.push({ label: fx.label, s });
      if (!bestFix || balanceScore(s) > balanceScore(bestFix.s)) bestFix = { ...fx, s };
    }
    if (bestFix) bestFix = { ...bestFix, s: summarize(runMany(N, makeConfig(bestFix.overrides))) };
  }

  // ---- per-map and per-start tables
  const byMap = MAP_SEEDS.map((m) => {
    const rs = results.filter((r) => r.spec.mapSeed === m);
    const w = Object.fromEntries(STRATEGIES.map((s) => [s, rs.filter((r) => r.winnerStrategy === s).length]));
    return [`${m} (${rs[0]?.spec.worldCount ?? '?'} worlds)`, rs.length, ...STRATEGIES.map((s) => w[s]!), summarizeWins(rs)];
  });
  const byStart = STRATEGIES.map((s) => {
    const cells = RING_NAMES.map((_, ring) => {
      const rs = results.filter((r) => {
        const pid = r.spec.setups.findIndex((x) => x.strategy === s);
        return r.spec.setups[pid]!.startRing === ring && r.spec.lateStarter !== pid;
      });
      const w = rs.filter((r) => r.winnerStrategy === s).length;
      return rs.length ? `${pct(w / rs.length)} (${w}/${rs.length})` : '-';
    });
    return [s, ...cells];
  });
  // Win rate of any strategy by start ring (pooled).
  const pooledStart = RING_NAMES.map((name, ring) => {
    let n = 0;
    let w = 0;
    for (const r of results) {
      r.spec.setups.forEach((x, pid) => {
        if (x.startRing !== ring || r.spec.lateStarter === pid) return;
        n++;
        if (r.winner === pid) w++;
      });
    }
    return [name, n, pct(w / Math.max(1, n))];
  });
  const lates = results.filter((r) => r.spec.lateStarter !== null);
  const lateDist = [1, 2, 3, 4].map((k) => lates.filter((r) => r.ranks[r.spec.lateStarter!] === k).length);
  const lateByStrategy = STRATEGIES.map((s) => {
    const rs = lates.filter((r) => r.spec.setups[r.spec.lateStarter!]!.strategy === s);
    const ranks = rs.map((r) => r.ranks[r.spec.lateStarter!]!);
    return [s, rs.length, rs.length ? f2(ranks.reduce((a, b) => a + b, 0) / rs.length) : '-', ranks.filter((x) => x === 1).length, ranks.filter((x) => x <= 2).length];
  });
  const lateBankRatio = lates.length
    ? lates.map((r) => r.banks[r.spec.lateStarter!]! / Math.max(1, r.banks[r.winner]!)).reduce((a, b) => a + b, 0) / lates.length
    : 0;
  const meanBank = STRATEGIES.map((s) => {
    const xs = results.map((r) => r.banks[r.spec.setups.findIndex((x) => x.strategy === s)]!).sort((a, b) => a - b);
    const worlds = results.map((r) => r.worldsHeld[r.spec.setups.findIndex((x) => x.strategy === s)]!);
    return [s, Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), Math.round(xs[Math.floor(xs.length / 2)]!), f2(worlds.reduce((a, b) => a + b, 0) / worlds.length)];
  });

  // ---- best sweep values
  const bestByKnob = sweeps.map((sw) => {
    const rows = sweepRows.filter((r) => r.knob === sw.knob);
    return rows.reduce((a, b) => (balanceScore(b.s) > balanceScore(a.s) ? b : a));
  });

  // ---- combined recommendation: the best fix plus every swept value that clearly beat the default
  const defaultRow = (knob: string) => sweepRows.find((r) => r.knob === knob && r.value === String((cfg as Record<string, unknown>)[knob]));
  const combo: Partial<Config> = { ...(bestFix?.overrides ?? {}) };
  const comboParts: string[] = bestFix ? [bestFix.label] : [];
  for (const b of bestByKnob) {
    const d = defaultRow(b.knob);
    if (d && b.value !== d.value && balanceScore(b.s) > balanceScore(d.s) + 0.05) {
      (combo as Record<string, number>)[b.knob] = Number(b.value);
      comboParts.push(`${b.knob} ${d.value} -> ${b.value}`);
    }
  }
  const comboS = comboParts.length > (bestFix ? 1 : 0) ? summarize(runMany(N, makeConfig(combo))) : null;

  // ---- verdicts
  const q1 = S.maxShare >= 0.9
    ? `**Yes.** The ${S.dominant} wins ${pct(S.maxShare)} of ${N} seasons.`
    : dominantFound
      ? `**Not always, but one strategy is clearly favoured: the ${S.dominant} wins ${pct(S.maxShare)} of ${N} seasons** (an even game would be 25%; margin about +-${pct(margin(S.maxShare, N))}). Every strategy wins some seasons: ${STRATEGIES.map((x) => `${x} ${pct(S.share[x])}`).join(', ')}.`
      : `**No.** The most successful strategy, the ${S.dominant}, wins ${pct(S.maxShare)} of ${N} seasons (even would be 25%); every strategy wins some seasons.`;
  const q1b = `Winner spread (normalized entropy, 1.00 = all four equally often): ${f2(S.entropy)}. The top strategy differs between maps: ${S.mapsWithDifferentTop} different strategies are the most frequent winner on at least one of the ${MAP_SEEDS.length} maps.`;
  const q2 = S.snowball25 >= 0.75
    ? `**Yes, mostly.** The leader at 25% of the season is still the leader at the end in ${pct(S.snowball25)} of seasons (${pct(S.snowball50)} for the leader at 50%).`
    : `**No.** The leader at 25% of the season finishes first in ${pct(S.snowball25)} of seasons (the leader at 50% in ${pct(S.snowball50)}). With four players a random leader would hold on 25% of the time.`;
  const lateVerdict = S.lateMeanRank === null
    ? ''
    : S.lateMeanRank <= 2.5
      ? '**Yes.**'
      : `**Not at the defaults.**`;
  const lateLine = S.lateMeanRank !== null
    ? `Late starters (${lates.length} seasons; they join 20-30% into the season at the edge) finish with a mean rank of ${f2(S.lateMeanRank)} of 4, in the top two ${pct(S.lateTop2!)} of the time, and win ${lateDist[0]} times.`
    : 'No late starters in this run.';

  const md: string[] = [];
  md.push('# Dominion API balance report', '');
  md.push(`Generated by \`node --import tsx sim/dominion/run.ts --seasons ${N} --sweep ${SWEEP_N}\`. ${N} seasons of ${cfg.seasonLength} ticks, four bots (one per strategy), ${MAP_SEEDS.length} maps of 40-80 worlds, random start rings, and a late starter in ${lates.length} seasons. Everything is deterministic: the same command gives the same report.`, '');
  md.push('## The two questions', '');
  md.push('### 1. Does one strategy always win?', '', q1, '', q1b, '');
  md.push('### 2. Does the early leader always stay ahead?', '', q2, '');
  md.push('### And can a late starter at the edge still finish well?', '', `${lateVerdict} ${lateLine}`, '');
  md.push('## Win rate per strategy', '');
  md.push(table(['strategy', 'wins', 'win rate', '95% margin', 'mean final bank', 'median final bank', 'worlds held at end'], STRATEGIES.map((s, i) => [s, S.wins[s], pct(S.share[s]), `+-${pct(margin(S.share[s], N))}`, meanBank[i]![1]!, meanBank[i]![2]!, meanBank[i]![3]!])), '');
  md.push('## Wins by map', '', 'Each map seed is a different layout (world count in brackets). Columns are wins per strategy.', '');
  md.push(table(['map', 'seasons', ...STRATEGIES, 'top'], byMap), '');
  md.push('## Wins by start position', '', 'Win rate of each strategy when it starts in a given ring (late starters left out). Rows are strategies, columns the start ring.', '');
  md.push(table(['strategy', ...RING_NAMES], byStart), '');
  md.push('Pooled over strategies (an even game would be 25% everywhere):', '');
  md.push(table(['start ring', 'starts', 'win rate'], pooledStart), '');
  md.push('## Snowball check', '');
  md.push(table(['measure', 'value'], [
    ['leader at 25% of the season wins', pct(S.snowball25)],
    ['leader at 50% of the season wins', pct(S.snowball50)],
    ['random guess with 4 players', '25%'],
  ]), '');
  md.push('## Late starters', '', lateLine, '');
  md.push(table(['final rank', '1', '2', '3', '4'], [['seasons', ...lateDist]]), '');
  md.push(table(['late starter strategy', 'seasons', 'mean rank', 'wins', 'top two'], lateByStrategy), '');
  md.push(`On average a late starter ends with ${pct(lateBankRatio)} of the winner's bank.`, '');
  md.push('## Sensitivity sweep', '', `${SWEEP_N} seasons per value, on a separate set of seeds shared by every row (so rows compare with each other, and the default row differs a little from the main run by sampling alone). "Entropy" is how evenly the four strategies share the wins (1.00 = evenly). "Balance" = entropy minus penalties for a leader@25% win rate above 25%, a top strategy above 40%, and a late-starter mean rank worse than 2.5; higher is better.`, '');
  md.push(table(['knob', 'value', ...STRATEGIES, 'entropy', 'leader@25% wins', 'late mean rank', 'balance'], sweepRows.map((r) => [
    r.knob, r.value, ...STRATEGIES.map((s) => pct(r.s.share[s])), f2(r.s.entropy), pct(r.s.snowball25), r.s.lateMeanRank === null ? '-' : f2(r.s.lateMeanRank), f2(balanceScore(r.s)),
  ])), '');
  md.push('Best value per knob on this measure:', '');
  for (const b of bestByKnob) md.push(`- \`${b.knob}\` = ${b.value} (entropy ${f2(b.s.entropy)}, leader@25% wins ${pct(b.s.snowball25)}, top strategy ${b.s.dominant} at ${pct(b.s.maxShare)})`);
  md.push('');
  md.push('## Dominance and the fix', '');
  if (dominantFound && bestFix) {
    md.push(`The ${S.dominant} wins more than 40% of seasons at the defaults, so the knobs aimed at that strategy were tried (${SWEEP_N} seasons each, same seeds):`, '');
    md.push(table(['change', ...STRATEGIES, 'entropy', 'leader@25% wins', 'balance'], fixRows.map((r) => [r.label, ...STRATEGIES.map((s) => pct(r.s.share[s])), f2(r.s.entropy), pct(r.s.snowball25), f2(balanceScore(r.s))])), '');
    md.push(`Best single change: **${bestFix.label}**. Re-run over the full ${N} seasons (the main seeds):`, '');
    md.push(table(['', ...STRATEGIES, 'entropy', 'leader@25% wins', 'late mean rank'], [
      ['defaults', ...STRATEGIES.map((s) => pct(S.share[s])), f2(S.entropy), pct(S.snowball25), S.lateMeanRank === null ? '-' : f2(S.lateMeanRank)],
      [bestFix.label, ...STRATEGIES.map((s) => pct(bestFix!.s.share[s])), f2(bestFix.s.entropy), pct(bestFix.s.snowball25), bestFix.s.lateMeanRank === null ? '-' : f2(bestFix.s.lateMeanRank)],
    ]), '');
  } else {
    md.push(`No strategy wins more than 40% of seasons at the defaults (top: ${S.dominant} at ${pct(S.maxShare)}), so no fix run was needed.`, '');
  }
  if (comboS) {
    md.push('## Recommended settings, combined', '');
    md.push(`Applying together: ${comboParts.map((x) => `\`${x}\``).join(', ')}. Full ${N} seasons on the main seeds:`, '');
    md.push(table(['', ...STRATEGIES, 'entropy', 'leader@25% wins', 'leader@50% wins', 'late mean rank', 'late top two', 'balance'], [S, comboS].map((x, i) => [
      i === 0 ? 'defaults' : 'combined', ...STRATEGIES.map((st) => pct(x.share[st])), f2(x.entropy), pct(x.snowball25), pct(x.snowball50),
      x.lateMeanRank === null ? '-' : f2(x.lateMeanRank), x.lateTop2 === null ? '-' : pct(x.lateTop2), f2(balanceScore(x)),
    ])), '');
  }
  md.push('## Change from the previous defaults', '');
  md.push(`The defaults changed on 2026-11-26: \`terraformStep 0.6 -> 0.4\` and \`lateJoinGrant 0 -> 40\` (the combined recommendation of the previous report). Full ${N} seasons on the main seeds:`, '');
  md.push(table(['', ...STRATEGIES, 'entropy', 'leader@25% wins', 'leader@50% wins', 'late mean rank', 'late top two', 'balance'], [prevS, S].map((x, i) => [
    i === 0 ? 'previous defaults' : 'new defaults', ...STRATEGIES.map((st) => pct(x.share[st])), f2(x.entropy), pct(x.snowball25), pct(x.snowball50),
    x.lateMeanRank === null ? '-' : f2(x.lateMeanRank), x.lateTop2 === null ? '-' : pct(x.lateTop2), f2(balanceScore(x)),
  ])), '');
  md.push('## Reading the results', '');
  for (const r of sweepRows.filter((x) => x.knob === 'bandwidthExponent' && x.s.maxShare >= 0.75)) {
    md.push(`- With \`bandwidthExponent\` = ${r.value} the ${r.s.dominant} wins ${pct(r.s.maxShare)} and the leader at 25% wins ${pct(r.s.snowball25)}: without the square-root curve, the biggest empire simply out-acts everyone. The sqrt rule is doing real work.`);
  }
  if (dominantFound && bestFix) {
    md.push(`- The ${S.dominant} is the strategy to tune. \`${bestFix.label}\` brings it from ${pct(S.maxShare)} to ${pct(bestFix.s.share[S.dominant])} of wins.`);
    if (bestFix.s.snowball25 > S.snowball25 + 0.05) {
      md.push(`- Weakening it raises the snowball rate (leader@25% wins ${pct(S.snowball25)} -> ${pct(bestFix.s.snowball25)}), because the ${S.dominant}'s late surge was what overturned early leaders. That is still well short of "always", but it means the comeback mechanic needs a second source once the ${S.dominant} is tamed: \`leaderWeight\` alone did not provide it in the sweep.`);
    }
  }
  if (S.lateMeanRank !== null && S.lateMeanRank > 2.5) {
    const g = sweepRows.filter((x) => x.knob === 'lateJoinGrant');
    const best = g.reduce((a, b) => ((a.s.lateMeanRank ?? 9) < (b.s.lateMeanRank ?? 9) ? a : b));
    md.push(`- The newcomer floor and the cheap edge are not enough for a late starter: mean rank ${f2(S.lateMeanRank)} of 4. A catch-up grant helps (\`lateJoinGrant\` = ${best.value} gives a mean rank of ${best.s.lateMeanRank === null ? '-' : f2(best.s.lateMeanRank)} in the sweep) without changing which strategies win.`);
  }
  md.push('');
  md.push('## Caveats', '');
  md.push('- The bots are simple first-week scripts. A strategy that loses here may only be badly played; a strategy that wins may be exploiting a bot that does not defend well. Treat the numbers as a first read on the rules, not a verdict on human play.');
  md.push('- Every season has exactly one player per strategy, so "win rate" means "wins against one of each other strategy".');
  md.push('- The score is resources in the bank at the end of the season. A different victory rule (held worlds, a mix) would change which strategy is strongest.');
  md.push('');
  writeFileSync(outPath, md.join('\n'));

  // ---- console summary
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Dominion API balance sim: ${N} seasons (+ sweep ${SWEEP_N}/value) in ${secs}s`);
  console.log(`Win rate: ${STRATEGIES.map((s) => `${s} ${pct(S.share[s])}`).join(', ')}  (entropy ${f2(S.entropy)})`);
  console.log(`Leader at 25% wins: ${pct(S.snowball25)}; at 50%: ${pct(S.snowball50)}`);
  if (S.lateMeanRank !== null) console.log(`Late starters: mean rank ${f2(S.lateMeanRank)}/4, top two ${pct(S.lateTop2!)}, wins ${lateDist[0]}/${lates.length}`);
  for (const b of bestByKnob) console.log(`Sweep best ${b.knob} = ${b.value} (entropy ${f2(b.s.entropy)}, leader@25% ${pct(b.s.snowball25)})`);
  if (dominantFound && bestFix) console.log(`Dominant: ${S.dominant}. Best fix: ${bestFix.label} -> ${STRATEGIES.map((s) => `${s} ${pct(bestFix!.s.share[s])}`).join(', ')}`);
  if (comboS) console.log(`Combined (${comboParts.join('; ')}): ${STRATEGIES.map((x) => `${x} ${pct(comboS.share[x])}`).join(', ')}; leader@25% ${pct(comboS.snowball25)}; late mean rank ${comboS.lateMeanRank === null ? '-' : f2(comboS.lateMeanRank)}`);
  console.log(`Report: ${outPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
