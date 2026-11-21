import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDispatchWorld, worldCallbacks, type WorldSource } from "../src/engine/dispatchWorld.js";
import { findJumpPath } from "../src/engine/jumpGraph.js";
import { fuelChainReaches } from "../src/engine/fuelChain.js";

// A random galaxy: 60 systems, sparse directed gate links (some one-way), some links unfinished.
let seed = 11;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const N = 60;
const sys = (i: number): string => `X1-S${i}`;
const links = new Map<string, Set<string>>();
for (let i = 0; i < N; i++) links.set(sys(i), new Set());
for (let i = 0; i < N * 2; i++) {
  const a = sys(Math.floor(rnd() * N)), b = sys(Math.floor(rnd() * N));
  if (a === b) continue;
  links.get(a)!.add(b);
  if (rnd() < 0.8) links.get(b)!.add(a);
}
const unfinished = new Set<string>();
for (const [a, bs] of links) for (const b of bs) if (rnd() < 0.15) unfinished.add(`${a}>${b}`);
const waypoints = new Map<string, { symbol: string; x: number; y: number }[]>();
for (let i = 0; i < N; i++) {
  waypoints.set(sys(i), Array.from({ length: 8 }, (_, j) => ({ symbol: `${sys(i)}-W${j}`, x: Math.floor(rnd() * 600), y: Math.floor(rnd() * 600) })));
}
const fuelStops = new Map<string, string[]>();
for (let i = 0; i < N; i++) fuelStops.set(sys(i), waypoints.get(sys(i))!.filter(() => rnd() < 0.4).map((w) => w.symbol));
const usable = (a: string): string[] => [...(links.get(a) ?? [])].filter((b) => !unfinished.has(`${a}>${b}`));
const source: WorldSource = {
  positioningHops: 4,
  usableNeighbors: usable,
  jumpCandidates: (a) => [...(links.get(a) ?? [])],
  canJumpInto: (a, b) => (links.get(a)?.has(b) ?? false) && !unfinished.has(`${a}>${b}`) && Number(b.slice(4)) % 7 !== 3,
  gateFor: (a, b) => (links.get(a)?.has(b) ? `${a}-W0` : undefined),
  hopCost: (a, b) => 1000 + (Number(a.slice(4)) * 31 + Number(b.slice(4))) % 5000,
  waypointsIn: (s) => waypoints.get(s) ?? [],
  fuelStops,
};
// The live callbacks, as fleet.ts builds them from the galaxy and registry.
const coords = new Map([...waypoints.values()].flat().map((w) => [w.symbol, w]));
const live = {
  canJump: source.canJumpInto,
  distanceBetween: (a: string, b: string): number => {
    if (a.slice(0, a.lastIndexOf("-")) !== b.slice(0, b.lastIndexOf("-"))) return Infinity;
    const p = coords.get(a), q = coords.get(b);
    if (!p || !q) return Infinity;
    return Math.max(1, Math.round(Math.hypot(q.x - p.x, q.y - p.y)));
  },
  path: (a: string, b: string) => (source.canJumpInto(a, b) ? [a, b] : findJumpPath(a, b, usable, source.positioningHops)),
};
const liveFuel = (s: string, a: string, b: string, cap: number): boolean => {
  const stops = fuelStops.get(s);
  return stops ? fuelChainReaches(a, b, stops, cap, live.distanceBetween) : false;
};

const seeds = [sys(0), sys(5), sys(17), sys(33), sys(42)];
const world = buildDispatchWorld(source, seeds);
const cb = worldCallbacks(world);
const all = Array.from({ length: N }, (_, i) => sys(i));

describe("dispatch world", () => {
  it("answers jumps and paths from every seed exactly as the live galaxy", () => {
    let paths = 0;
    for (const a of seeds) for (const b of all) {
      assert.equal(cb.canJump(a, b), live.canJump(a, b), `${a}>${b}`);
      const want = live.path(a, b);
      assert.deepEqual(cb.path(a, b), want, `${a}>${b}`);
      if (want) paths += 1;
    }
    assert.ok(paths > 10, "fixture should have paths");
  });

  it("gives every edge on those paths its gate both ways and its hop cost", () => {
    for (const a of seeds) for (const b of all) {
      const p = live.path(a, b);
      if (!p) continue;
      for (let i = 0; i + 1 < p.length; i++) {
        assert.equal(cb.hopCost(p[i]!, p[i + 1]!), source.hopCost(p[i]!, p[i + 1]!));
        assert.equal(cb.gateFor(p[i]!, p[i + 1]!), source.gateFor(p[i]!, p[i + 1]!));
        assert.equal(cb.gateFor(p[i + 1]!, p[i]!), source.gateFor(p[i + 1]!, p[i]!));
      }
    }
  });

  it("measures distances in seed systems and between relay gates and fuel stops", () => {
    for (const s of seeds) for (const a of waypoints.get(s)!) for (const b of waypoints.get(s)!) {
      assert.equal(cb.distanceBetween(a.symbol, b.symbol), live.distanceBetween(a.symbol, b.symbol));
    }
    assert.equal(cb.distanceBetween(`${sys(0)}-W1`, `${sys(5)}-W1`), Infinity);
    for (const a of seeds) for (const b of all) {
      const p = live.path(a, b);
      if (!p) continue;
      for (let i = 1; i + 1 < p.length; i++) {
        const arrive = source.gateFor(p[i]!, p[i - 1]!), leave = source.gateFor(p[i]!, p[i + 1]!);
        if (!arrive || !leave) continue;
        assert.equal(cb.distanceBetween(arrive, leave), live.distanceBetween(arrive, leave));
        for (const cap of [50, 200, 400]) assert.equal(cb.hasFuelStop(p[i]!, arrive, leave, cap), liveFuel(p[i]!, arrive, leave, cap), `${p[i]} ${cap}`);
      }
    }
  });

  it("is plain data: survives a structured clone unchanged", () => {
    const copy = structuredClone(world);
    assert.deepEqual(copy, world);
    const again = worldCallbacks(copy);
    for (const a of seeds) for (const b of all) assert.deepEqual(again.path(a, b), live.path(a, b));
  });
});
