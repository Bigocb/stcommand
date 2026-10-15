/**
 * A version for the galaxy part of the dashboard snapshot (systems, waypoints, jump connections), so screens can
 * fetch the galaxy only when it changes instead of with every poll.
 *
 * The galaxy changes during the week: a gate finishes, a new system is discovered, a waypoint is charted. The version
 * is a hash over exactly what the screens draw, so any of those changes it, and nothing else does.
 *
 * Pure apart from a memo keyed on the arrays themselves: the snapshot replaces its arrays when they change, so the
 * same arrays always hash the same and are hashed once.
 */
import type { FleetSnapshot } from "./state.js";

type Galaxy = Pick<FleetSnapshot, "systems" | "jumpConnections">;

const memo = new WeakMap<object, { connections: object; version: string }>();

/** FNV-1a, 32 bit: a fast, stable string hash. Collisions only cost a missed refresh until the next change. */
function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function galaxyVersion(g: Galaxy): string {
  const cached = memo.get(g.systems);
  if (cached && cached.connections === g.jumpConnections) return cached.version;
  let h = 0x811c9dc5;
  let waypoints = 0;
  for (const s of g.systems) {
    h = fnv(h, `${s.symbol}|${s.type ?? ""}|${s.jumpGates.join(",")}`);
    for (const w of s.waypoints) {
      waypoints++;
      h = fnv(h, `${w.symbol}:${w.type}:${w.x},${w.y}:${w.traits.join(",")}`);
    }
  }
  for (const c of g.jumpConnections) h = fnv(h, `${c.from}>${c.to}:${c.complete === true ? 1 : c.complete === false ? 0 : "?"}`);
  // The counts in front make a version readable at a glance and separate most changes even before the hash.
  const version = `${g.systems.length}.${waypoints}.${g.jumpConnections.length}.${h.toString(36)}`;
  memo.set(g.systems, { connections: g.jumpConnections, version });
  return version;
}
