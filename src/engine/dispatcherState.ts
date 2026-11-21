/**
 * RouteDispatcher state as plain, structured-clone-safe data (issue #70, stage 2), and the three-way merge that lets a
 * recompute run on a copy while the main thread keeps changing the original.
 *
 * Export walks the dispatcher's own fields, so a field added later is carried without anyone remembering to list it.
 * Functions (the logger, the memory-change hook) stay behind. A RouteBlocks instance is carried as its entries. Anything
 * else that cannot be cloned makes the export throw, and the worker host then runs the recompute in-thread as before.
 *
 * Merge (before = the state sent to the worker, main = the main thread's state when the result arrives, after = the
 * worker's state after recompute):
 * - a Map or Set: key by key, the main thread's value where it changed the key since `before`, otherwise the worker's;
 * - an array: the worker's, plus whatever the main thread appended since `before` (all the dispatcher's arrays are logs
 *   or histories); if the main thread replaced the array rather than appending, the main thread's;
 * - a number inside an object (the circuit counters): both sides' increments added; a top-level number: whichever side
 *   changed it, the main thread's if both did;
 * - a plain object: the same rules field by field; anything else: the main thread's if it changed, else the worker's.
 * So a claim, decline, sale or manual route made while the recompute was running is kept, and everything the recompute
 * decided that the main thread did not touch is installed. Afterwards an auto assignment from the recompute that takes a
 * good a main-thread claim took in the meantime is dropped (the next recompute hands that ship something else).
 */
import { RouteBlocks } from "./routeBlocks.js";

export type DispatcherState = Record<string, unknown>;

const ROUTE_BLOCKS = "__routeBlocks";

/** The dispatcher's fields as cloneable values. */
export function exportDispatcherState(dispatcher: object): DispatcherState {
  const out: DispatcherState = {};
  for (const [key, value] of Object.entries(dispatcher)) {
    if (typeof value === "function") continue;
    if (value instanceof RouteBlocks) {
      out[key] = { [ROUTE_BLOCKS]: [...((value as unknown as { blocks: Map<string, unknown> }).blocks).entries()] };
      continue;
    }
    out[key] = value;
  }
  return structuredClone(out);
}

/** Put exported state back onto a dispatcher (a fresh one in the worker, or the live one after a merge). */
export function importDispatcherState(dispatcher: object, state: DispatcherState): void {
  const target = dispatcher as Record<string, unknown>;
  for (const [key, value] of Object.entries(state)) {
    if (isRouteBlocks(value)) {
      const blocks = target[key] instanceof RouteBlocks ? target[key] as RouteBlocks : new RouteBlocks();
      const map = (blocks as unknown as { blocks: Map<string, unknown> }).blocks;
      map.clear();
      for (const [k, v] of value[ROUTE_BLOCKS]) map.set(k, v);
      target[key] = blocks;
      continue;
    }
    if (typeof target[key] === "function") continue;
    target[key] = value;
  }
}

function isRouteBlocks(v: unknown): v is { [ROUTE_BLOCKS]: [string, unknown][] } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) && ROUTE_BLOCKS in v;
}

/** Structural equality over what export produces: primitives, arrays, plain objects, Maps and Sets. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !same(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (b instanceof Map || b instanceof Set || Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set);

/** Three-way merge of one value (see the module comment). */
export function mergeValue(before: unknown, main: unknown, after: unknown, inObject = false): unknown {
  const mainChanged = !same(before, main);
  if (!mainChanged) return after;
  const workerChanged = !same(before, after);
  if (!workerChanged) return main;
  if (main instanceof Map && before instanceof Map && after instanceof Map) {
    const out = new Map();
    const keys = new Set([...before.keys(), ...main.keys(), ...after.keys()]);
    for (const k of keys) {
      const b = before.get(k), m = main.get(k), w = after.get(k);
      const keyChangedOnMain = before.has(k) !== main.has(k) || !same(b, m);
      if (keyChangedOnMain) { if (main.has(k)) out.set(k, m); }
      else if (after.has(k)) out.set(k, w);
    }
    return out;
  }
  if (main instanceof Set && before instanceof Set && after instanceof Set) {
    const out = new Set();
    for (const v of new Set([...before, ...main, ...after])) {
      const onMain = main.has(v);
      if (before.has(v) !== onMain) { if (onMain) out.add(v); }
      else if (after.has(v)) out.add(v);
    }
    return out;
  }
  if (Array.isArray(main) && Array.isArray(before) && Array.isArray(after)) {
    const appended = main.length >= before.length && before.every((v, i) => same(v, main[i]));
    return appended ? [...after, ...main.slice(before.length)] : main;
  }
  // Counters inside an object (circuitCounts) add both sides' increments; a top-level number both changed is a setting or a
  // timestamp, and the main thread's is the newer.
  if (inObject && typeof main === "number" && typeof before === "number" && typeof after === "number") return after + (main - before);
  if (isPlain(main) && isPlain(before) && isPlain(after)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(main), ...Object.keys(after)])) {
      const v = mergeValue(before[k], main[k], after[k], true);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return main;
}

type Assignment = { good: string; role?: string; source?: string; shipSymbol?: string };

/** Merge whole states, then drop recompute-made auto direct assignments whose good a main-thread change now holds. */
export function mergeDispatcherState(before: DispatcherState, main: DispatcherState, after: DispatcherState): { state: DispatcherState; dropped: string[] } {
  const state: DispatcherState = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(main), ...Object.keys(after)])) {
    const b = before[key], m = main[key], w = after[key];
    state[key] = isRouteBlocks(m) || isRouteBlocks(w)
      ? mergeRouteBlocks(b, m, w)
      : mergeValue(b, m, w);
  }
  const dropped: string[] = [];
  const merged = state.assignments, mainA = main.assignments, beforeA = before.assignments;
  if (merged instanceof Map && mainA instanceof Map && beforeA instanceof Map) {
    const heldByMain = new Map<string, string>();
    for (const [ship, a] of mainA as Map<string, Assignment>) {
      if (!same(beforeA.get(ship), a) && a.role === "direct") heldByMain.set(a.good, ship);
    }
    for (const [ship, a] of merged as Map<string, Assignment>) {
      const holder = heldByMain.get(a.good);
      if (holder !== undefined && holder !== ship && a.role === "direct" && a.source === "auto" && same(beforeA.get(ship), mainA.get(ship))) {
        merged.delete(ship);
        dropped.push(`${ship}:${a.good}`);
      }
    }
  }
  return { state, dropped };
}

function mergeRouteBlocks(before: unknown, main: unknown, after: unknown): unknown {
  const asMap = (v: unknown): Map<string, unknown> => new Map(isRouteBlocks(v) ? v[ROUTE_BLOCKS] : []);
  const merged = mergeValue(asMap(before), asMap(main), asMap(after)) as Map<string, unknown>;
  return { [ROUTE_BLOCKS]: [...merged.entries()] };
}
