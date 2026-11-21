/**
 * The dispatch world: everything RouteDispatcher.recompute() asks the galaxy and the registry, as plain data
 * (issue #70, stage 1). recompute() takes six callbacks into live fleet state (canJump, distanceBetween, hasFuelStop,
 * crossSystem.path / hopCost / gateFor). A worker thread cannot call back into the main thread synchronously, so the
 * main thread builds this object once per recompute and the callbacks are rebuilt from it (worldCallbacks()) on either
 * side. Pure: no I/O, no clock; everything comes in through the source.
 *
 * Coverage. recompute() only asks about systems a trader, a route or a target touches (the seeds) and the systems on
 * a jump path out of them. findJumpPath() never looks further than `positioningHops` jumps from its start, so the
 * seeds' neighbourhoods to that radius answer every path query exactly. Distances are only asked inside one system,
 * between waypoints of seed systems, or between the gates and fuel stops of a relay system on a path; those are the
 * coordinates kept. A question outside the coverage answers as the live source does for something it does not know:
 * no jump, no path, distance Infinity.
 */
import { findJumpPath } from "./jumpGraph.js";
import { fuelChainReaches } from "./fuelChain.js";
import { CROSS_SYSTEM_JUMP_COST_ESTIMATE as JUMP_COST_FALLBACK } from "./dispatcher.js";

export interface DispatchWorld {
  /** Jumps a positioning path may take (galaxy positioning-hops setting). */
  positioningHops: number;
  /** usableNeighbors() per covered system: the edges jumpPath() searches. */
  neighbors: Record<string, string[]>;
  /** Systems canJumpInto(system, x) is true for, per covered system. */
  jumpInto: Record<string, string[]>;
  /** First gate in `a` toward `b` (galaxy.gatesTo(a, b)[0]), keyed `a>b`, for every edge above. */
  gates: Record<string, string>;
  /** Credits for one jump a -> b (fleet.crossSystemLegCost), keyed `a>b`, for every edge above. */
  hopCosts: Record<string, number>;
  /** Waypoint coordinates [x, y]. */
  coords: Record<string, [number, number]>;
  /** Fuel-selling waypoints per system, for the relay check. */
  fuelStops: Record<string, string[]>;
}

/** What the builder reads. The fleet passes thin wrappers over its galaxy and registry. */
export interface WorldSource {
  positioningHops: number;
  usableNeighbors(system: string): string[];
  /** Every system a jump out of `system` could go to (gate connections and proven jumps); canJumpInto filters them. */
  jumpCandidates(system: string): string[];
  canJumpInto(from: string, to: string): boolean;
  gateFor(from: string, to: string): string | undefined;
  hopCost(from: string, to: string): number;
  /** Every waypoint of a system with its coordinates; empty when the system was never loaded. */
  waypointsIn(system: string): { symbol: string; x: number; y: number }[];
  fuelStops: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>;
}

const systemOf = (waypoint: string): string => waypoint.slice(0, waypoint.lastIndexOf("-"));

/**
 * Build the world for one recompute. `seedSystems` are the systems the traders, routes and targets are in (sell systems
 * included); `extraWaypoints` are waypoints that must have coordinates even outside the seed systems (traders' own
 * positions, free-at waypoints).
 */
export function buildDispatchWorld(source: WorldSource, seedSystems: Iterable<string>, extraWaypoints: Iterable<string> = []): DispatchWorld {
  const seeds = new Set<string>();
  for (const s of seedSystems) if (s) seeds.add(s);
  const world: DispatchWorld = { positioningHops: source.positioningHops, neighbors: {}, jumpInto: {}, gates: {}, hopCosts: {}, coords: {}, fuelStops: {} };
  const edge = (a: string, b: string): void => {
    const key = `${a}>${b}`;
    if (key in world.hopCosts) return;
    world.hopCosts[key] = source.hopCost(a, b);
    const gate = source.gateFor(a, b);
    if (gate !== undefined) world.gates[key] = gate;
  };
  // Breadth-first from every seed at once, to the positioning radius, over the edges paths use.
  const depth = new Map<string, number>();
  let frontier = [...seeds];
  for (const s of frontier) depth.set(s, 0);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sys of frontier) {
      const d = depth.get(sys)!;
      const neighbors = source.usableNeighbors(sys);
      world.neighbors[sys] = [...neighbors];
      world.jumpInto[sys] = source.jumpCandidates(sys).filter((n) => source.canJumpInto(sys, n));
      // Both directions: the relay check asks for the gate a ship arrives through (gateFor(sys, previous)) as well as the
      // one it leaves by, and the arrival direction need not be one of this system's own usable edges.
      for (const n of neighbors) { edge(sys, n); edge(n, sys); }
      for (const n of world.jumpInto[sys]!) { edge(sys, n); edge(n, sys); }
      if (d >= world.positioningHops) continue;
      for (const n of neighbors) {
        if (depth.has(n)) continue;
        depth.set(n, d + 1);
        next.push(n);
      }
    }
    frontier = next;
  }
  // A system reached at the edge of the radius is still a valid path end: findJumpPath() only needs its id, but a
  // canJumpInto() from it is never asked (no query starts outside the seeds).
  const keepCoord = (wp: string, x: number, y: number): void => { world.coords[wp] = [x, y]; };
  for (const sys of seeds) for (const w of source.waypointsIn(sys)) keepCoord(w.symbol, w.x, w.y);
  // Relay systems: their gates and fuel stops.
  const wanted = new Set<string>(extraWaypoints);
  for (const g of Object.values(world.gates)) wanted.add(g);
  for (const [sys, stops] of source.fuelStops) {
    if (!depth.has(sys)) continue;
    world.fuelStops[sys] = [...stops];
    for (const s of stops) wanted.add(s);
  }
  const bySystem = new Map<string, Set<string>>();
  for (const wp of wanted) {
    if (wp in world.coords) continue;
    const sys = systemOf(wp);
    (bySystem.get(sys) ?? bySystem.set(sys, new Set()).get(sys)!).add(wp);
  }
  for (const [sys, wps] of bySystem) for (const w of source.waypointsIn(sys)) if (wps.has(w.symbol)) keepCoord(w.symbol, w.x, w.y);
  return world;
}

/** The six recompute() callbacks, answered from the world. Memoised per world: build a new one per recompute. */
export function worldCallbacks(world: DispatchWorld): {
  canJump: (from: string, to: string) => boolean;
  distanceBetween: (a: string, b: string) => number;
  hasFuelStop: (system: string, from: string, to: string, capacity: number) => boolean;
  path: (from: string, to: string) => string[] | undefined;
  hopCost: (from: string, to: string) => number;
  gateFor: (from: string, to: string) => string | undefined;
} {
  const jumpInto = new Map<string, Set<string>>();
  const canJump = (from: string, to: string): boolean => {
    let set = jumpInto.get(from);
    if (!set) { set = new Set(world.jumpInto[from] ?? []); jumpInto.set(from, set); }
    return set.has(to);
  };
  // Same rule as fleet.estimatedFuelBetween() over registry.distance(): Infinity across systems or for an unknown
  // waypoint, else the straight line rounded, at least 1.
  const distanceBetween = (a: string, b: string): number => {
    if (systemOf(a) !== systemOf(b)) return Infinity;
    const p = world.coords[a];
    const q = world.coords[b];
    if (!p || !q) return Infinity;
    return Math.max(1, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1])));
  };
  const paths = new Map<string, string[] | undefined>();
  const neighbors = (s: string): string[] => world.neighbors[s] ?? [];
  // fleet: canJumpInto(a, b) ? [a, b] : galaxy.jumpPath(a, b)
  const path = (from: string, to: string): string[] | undefined => {
    if (canJump(from, to)) return [from, to];
    const key = `${from}>${to}`;
    if (!paths.has(key)) paths.set(key, findJumpPath(from, to, neighbors, world.positioningHops));
    return paths.get(key)?.slice();
  };
  const fuelMemo = new Map<string, boolean>();
  const hasFuelStop = (system: string, from: string, to: string, capacity: number): boolean => {
    const key = `${system}|${from}|${to}|${capacity}`;
    const memo = fuelMemo.get(key);
    if (memo !== undefined) return memo;
    const stops = world.fuelStops[system];
    const reaches = stops ? fuelChainReaches(from, to, stops, capacity, distanceBetween) : false;
    fuelMemo.set(key, reaches);
    return reaches;
  };
  return {
    canJump,
    distanceBetween,
    hasFuelStop,
    path,
    hopCost: (from, to) => world.hopCosts[`${from}>${to}`] ?? JUMP_COST_FALLBACK,
    gateFor: (from, to) => world.gates[`${from}>${to}`],
  };
}
