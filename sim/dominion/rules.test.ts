// Run with: node --import tsx --test sim/dominion/rules.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSeasons, runSeason } from './run.ts';
import {
  type Action,
  type State,
  grossBandwidth,
  makeConfig,
  netBandwidth,
  newGame,
  step,
} from './rules.ts';

const cfg = makeConfig();

function game(overrides = {}): State {
  const c = makeConfig(overrides);
  return newGame(42, 101, c, { worldCount: 50 }, [
    { strategy: 'scorcher', startRing: 1, joinTick: 0 },
    { strategy: 'terraformer', startRing: 2, joinTick: 0 },
  ]);
}

test('a season is deterministic for a seed', () => {
  const [spec] = planSeasons(1, cfg);
  const a = runSeason(spec!, cfg);
  const b = runSeason(spec!, cfg);
  assert.deepEqual(a.banks, b.banks);
  assert.equal(a.winner, b.winner);
  const [other] = planSeasons(1, cfg, 8);
  assert.notDeepEqual(runSeason(other!, cfg).banks, a.banks);
});

test('step does not change its input', () => {
  const s0 = game();
  const copy = structuredClone(s0);
  step(s0, []);
  assert.deepEqual(s0, copy);
});

test('upkeep is charged for every held world each tick', () => {
  // No yield, no lanes bonus: the bank change is exactly the upkeep.
  let s = game({ ringYield: [0, 0, 0, 0], edgeExoticYield: 0, garrisonUpkeep: 0, leaderWeight: 0 });
  s = step(s, []); // players join and take their homes
  const p0 = s.players[0]!;
  const home = s.worlds[p0.homeWorld]!;
  const before = p0.bank;
  const free = s.adj[home.id]!.find((n) => s.worlds[n]!.owner === null)!;
  s = step(s, [{ player: 0, type: 'claim', target: free }]);
  const upkeep = 2 * s.config.upkeepRes + s.config.laneUpkeepRes; // two worlds and the lane between them
  const claimCost = before - s.players[0]!.bank - upkeep;
  assert.ok(claimCost > 0, 'the claim was paid for');
  const b1 = s.players[0]!.bank;
  s = step(s, []);
  assert.ok(Math.abs(b1 - s.players[0]!.bank - upkeep) < 1e-9, 'two worlds and one lane are charged');
  assert.equal(s.worlds.filter((w) => w.owner === 0).length, 2);
});

test('bandwidth upkeep reduces net actions, floored', () => {
  assert.ok(netBandwidth(cfg, 10) < grossBandwidth(cfg, 10));
  assert.equal(netBandwidth(cfg, 200), cfg.bandwidthFloor);
});

test('bandwidth grows with the square root of holdings', () => {
  const extra = (h: number) => grossBandwidth(cfg, h) - cfg.bandwidthBase;
  for (const h of [4, 9, 16, 25]) {
    const ratio = extra(2 * h) / extra(h);
    assert.ok(Math.abs(ratio - Math.SQRT2) < 1e-9, `doubling from ${h} gives x${ratio.toFixed(3)}`);
  }
  // about 40% more, not 100%
  assert.ok(Math.abs(extra(20) / extra(10) - 1 - 0.41) < 0.01);
});

test('stripping pays a burst and cuts the yield for the rest of the season', () => {
  let s = game({ leaderWeight: 0 });
  s = step(s, []);
  const home = s.players[0]!.homeWorld;
  const y0 = s.worlds[home]!.yield;
  const bank0 = s.players[0]!.bank;
  const strip: Action = { player: 0, type: 'strip', target: home };
  s = step(s, [strip]);
  const y1 = s.worlds[home]!.yield;
  assert.ok(Math.abs(y1 - y0 * (1 - cfg.stripDecay)) < 1e-9, 'yield falls by stripDecay');
  assert.ok(s.players[0]!.bank - bank0 > cfg.stripBurst * y0 * 0.9, 'the burst is paid');
  assert.ok(s.worlds[home]!.unrest > 0, 'stripping raises unrest');
  // the cut stays, and repeated strips compound down to the floor
  s = step(s, []);
  assert.equal(s.worlds[home]!.yield, y1);
  for (let i = 0; i < 30; i++) s = step(s, [strip]);
  const w = s.worlds[home]!;
  if (w.owner === 0) assert.ok(Math.abs(w.yield - w.baseYield * cfg.minYieldFrac) < 1e-9);
  else assert.ok(w.yield <= y1, 'a world lost to unrest keeps its damage');
});
