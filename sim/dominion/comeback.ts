// Dominion API balance simulation: comeback and scorcher experiments (2026-11-26).
//
//   node --import tsx sim/dominion/comeback.ts [--sweep 100] [--seasons 200] [--out sim/dominion/comeback.md]
//
// The default rules (terraformStep 0.4, lateJoinGrant 40) spread the wins but the leader at 25% of the season
// wins 48%. This sweeps candidate comeback mechanics and scorcher buffs on one shared seed set, then re-runs the
// best ones and their combination over the main seeds. Deterministic: the same command gives the same report.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, STRATEGIES, makeConfig } from './rules.ts';
import { type Summary, runMany, summarize } from './run.ts';

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number) => x.toFixed(2);
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// Same measure as run.ts: even wins, an early lead that does not decide the season, late starters who can place.
const balance = (s: Summary) =>
  s.entropy - 0.5 * Math.max(0, s.snowball25 - 0.25) - 0.5 * Math.max(0, s.maxShare - 0.4) - 0.2 * Math.max(0, (s.lateMeanRank ?? 2.5) - 2.5);

type Exp = { group: string; label: string; overrides: Partial<Config> };
const EXPERIMENTS: Exp[] = [
  { group: 'baseline', label: 'defaults', overrides: {} },
  // Comeback candidates
  { group: 'comeback', label: 'upkeepRes 1.0 -> 1.2', overrides: { upkeepRes: 1.2 } },
  { group: 'comeback', label: 'upkeepRes 1.0 -> 1.5', overrides: { upkeepRes: 1.5 } },
  { group: 'comeback', label: 'upkeepScaleExp 0 -> 0.5 (above 6 worlds)', overrides: { upkeepScaleExp: 0.5 } },
  { group: 'comeback', label: 'upkeepScaleExp 0 -> 1.0 (above 6 worlds)', overrides: { upkeepScaleExp: 1.0 } },
  { group: 'comeback', label: 'leaderUpkeepMult 0 -> 0.5', overrides: { leaderUpkeepMult: 0.5 } },
  { group: 'comeback', label: 'leaderUpkeepMult 0 -> 1.0', overrides: { leaderUpkeepMult: 1.0 } },
  { group: 'comeback', label: 'leaderUpkeepMult 0 -> 2.0', overrides: { leaderUpkeepMult: 2.0 } },
  { group: 'comeback', label: 'edgeLateYield 0 -> 0.5', overrides: { edgeLateYield: 0.5 } },
  { group: 'comeback', label: 'edgeLateYield 0 -> 1.0', overrides: { edgeLateYield: 1.0 } },
  { group: 'comeback', label: 'edgeLateYield 0 -> 2.0', overrides: { edgeLateYield: 2.0 } },
  // Scorcher buffs
  { group: 'scorcher', label: 'stripDecay 0.2 -> 0.12', overrides: { stripDecay: 0.12 } },
  { group: 'scorcher', label: 'stripBurst 8 -> 10', overrides: { stripBurst: 10 } },
  { group: 'scorcher', label: 'occupationUnrest 2 -> 1.5', overrides: { occupationUnrest: 1.5 } },
  { group: 'scorcher', label: 'captureUnrest 30 -> 20', overrides: { captureUnrest: 20 } },
  { group: 'scorcher', label: 'attackPower 4 -> 5', overrides: { attackPower: 5 } },
];

function main(): void {
  const args = process.argv.slice(2);
  const arg = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : def;
  };
  const SWEEP_N = Number(arg('sweep', '100'));
  const N = Number(arg('seasons', '200'));
  const outPath = arg('out', join(dirname(fileURLToPath(import.meta.url)), 'comeback.md'));
  const SWEEP_SEED = 99; // a separate seed set from the main run (baseSeed 7), shared by every row

  const rows = EXPERIMENTS.map((e) => {
    const s = summarize(runMany(SWEEP_N, makeConfig(e.overrides), SWEEP_SEED));
    console.log(`${e.label}: ${STRATEGIES.map((x) => `${x} ${pct(s.share[x])}`).join(', ')}; leader@25% ${pct(s.snowball25)}; balance ${f2(balance(s))}`);
    return { ...e, s };
  });
  const base = rows[0]!.s;

  // Best comeback: lowest leader@25% that keeps the top strategy at or under 40%; ties on balance.
  const comebacks = rows.filter((r) => r.group === 'comeback' && r.s.maxShare <= 0.4);
  const bestComeback = comebacks.sort((a, b) => a.s.snowball25 - b.s.snowball25 || balance(b.s) - balance(a.s))[0];
  // Best scorcher buff: the most scorcher wins without any strategy over 40% and without a worse snowball than defaults + 3 points.
  const buffs = rows.filter((r) => r.group === 'scorcher' && r.s.maxShare <= 0.4 && r.s.snowball25 <= base.snowball25 + 0.03);
  const bestBuff = buffs.sort((a, b) => b.s.share.scorcher - a.s.share.scorcher || balance(b.s) - balance(a.s))[0];

  const finals: { label: string; overrides: Partial<Config> }[] = [{ label: 'defaults', overrides: {} }];
  if (bestComeback) finals.push({ label: bestComeback.label, overrides: bestComeback.overrides });
  if (bestBuff) finals.push({ label: bestBuff.label, overrides: bestBuff.overrides });
  if (bestComeback && bestBuff) finals.push({ label: `${bestComeback.label} + ${bestBuff.label}`, overrides: { ...bestComeback.overrides, ...bestBuff.overrides } });
  const finalRows = finals.map((f) => {
    const s = summarize(runMany(N, makeConfig(f.overrides)));
    console.log(`FULL ${f.label}: ${STRATEGIES.map((x) => `${x} ${pct(s.share[x])}`).join(', ')}; leader@25% ${pct(s.snowball25)}; late ${s.lateMeanRank === null ? '-' : f2(s.lateMeanRank)}`);
    return { ...f, s };
  });

  // Hand-picked combinations, from reading the sweep: the leader surcharge is the only comeback that moves the
  // snowball a lot, but it lifts the terraformer and costs the scorcher, so pair it with the scorcher buff and a
  // terraformer counterweight.
  const COMBOS: { label: string; overrides: Partial<Config> }[] = [
    { label: 'leaderUpkeepMult 0.5 + stripDecay 0.12', overrides: { leaderUpkeepMult: 0.5, stripDecay: 0.12 } },
    { label: 'leaderUpkeepMult 0.3 + stripDecay 0.12', overrides: { leaderUpkeepMult: 0.3, stripDecay: 0.12 } },
    { label: 'leaderUpkeepMult 0.5 + stripDecay 0.12 + terraformCost 45', overrides: { leaderUpkeepMult: 0.5, stripDecay: 0.12, terraformCost: 45 } },
    { label: 'leaderUpkeepMult 0.5 + stripDecay 0.12 + terraformStep 0.3', overrides: { leaderUpkeepMult: 0.5, stripDecay: 0.12, terraformStep: 0.3 } },
    { label: 'leaderUpkeepMult 0.3 + stripDecay 0.12 + terraformCost 45', overrides: { leaderUpkeepMult: 0.3, stripDecay: 0.12, terraformCost: 45 } },
  ];
  const comboRows = COMBOS.map((c) => {
    const s = summarize(runMany(N, makeConfig(c.overrides)));
    console.log(`COMBO ${c.label}: ${STRATEGIES.map((x) => `${x} ${pct(s.share[x])}`).join(', ')}; leader@25% ${pct(s.snowball25)}; late ${s.lateMeanRank === null ? '-' : f2(s.lateMeanRank)}; balance ${f2(balance(s))}`);
    return { ...c, s };
  });

  const head = ['change', ...STRATEGIES, 'entropy', 'leader@25% wins', 'leader@50% wins', 'late mean rank', 'balance'];
  const row = (label: string, s: Summary) => [label, ...STRATEGIES.map((x) => pct(s.share[x])), f2(s.entropy), pct(s.snowball25), pct(s.snowball50), s.lateMeanRank === null ? '-' : f2(s.lateMeanRank), f2(balance(s))];
  const md: string[] = [];
  md.push('# Dominion: comeback and scorcher experiments', '');
  md.push(`Generated by \`node --import tsx sim/dominion/comeback.ts --sweep ${SWEEP_N} --seasons ${N}\`. Defaults: terraformStep 0.4, lateJoinGrant 40. Sweep rows use ${SWEEP_N} seasons on one shared seed set (separate from the main report's seeds); the final table re-runs the picks over the main ${N} seasons.`, '');
  md.push('Goal: bring the leader-at-25% win rate down from the defaults (48% on the main seeds; 25% would be random) without letting any strategy pass 40%, and lift the scorcher, which wins least.', '');
  md.push('## New knobs (off by default)', '');
  md.push('- `upkeepScaleExp` with `upkeepScaleRef` 6: above 6 worlds, every world\'s upkeep is multiplied by (worlds / 6)^exp. Big empires pay more per world.');
  md.push('- `leaderUpkeepMult`: the current leader (bank + 24 ticks of yield) pays this much extra upkeep.');
  md.push('- `edgeLateYield`: edge-ring output rises linearly over the season to (1 + this) at the end, a late frontier boom for whoever is out there.', '');
  for (const g of ['comeback', 'scorcher'] as const) {
    md.push(g === 'comeback' ? '## Comeback candidates' : '## Scorcher buffs', '');
    md.push(table(head, [row('defaults', base), ...rows.filter((r) => r.group === g).map((r) => row(r.label, r.s))]), '');
  }
  md.push('## Picks over the main seeds', '');
  md.push(`Best comeback (lowest leader@25% with no strategy over 40%): **${bestComeback?.label ?? 'none qualified'}**. Best scorcher buff (most scorcher wins, no strategy over 40%, snowball no worse than defaults + 3 points): **${bestBuff?.label ?? 'none qualified'}**.`, '');
  md.push(table(head, finalRows.map((r) => row(r.label, r.s))), '');
  md.push('## Combinations over the main seeds', '');
  md.push('The leader surcharge is the only comeback that moves the snowball a lot, but on its own it lifts the terraformer over 40% and costs the scorcher. These pair it with the scorcher buff and a terraformer counterweight.', '');
  md.push(table(head, [row('defaults', finalRows[0]!.s), ...comboRows.map((r) => row(r.label, r.s))]), '');
  writeFileSync(outPath, md.join('\n'));
  console.log(`Report: ${outPath}`);
}

main();
