/**
 * Agent watch: when each agent registered, what its start looked like, and how fast start-system gates get built
 * (docs/agent-watch.md).
 *
 * Pure planning for the watcher in agentWatcher.ts: no I/O, no clock (the caller passes `now`).
 *
 * The public API shows no registration time, so the best available is "first seen by a scan". A scan that finds an agent
 * the previous scan did not brackets its registration between the two (`priorScanAt`..`firstSeenAt`). An agent already
 * there when the watcher first ran for a reset is a `baseline` sighting: its real registration time is unknown and
 * `firstSeenAt` is only an upper bound, which is stored as such so no later reader mistakes it for a registration time.
 */

export interface PublicAgent {
  symbol: string;
  headquarters: string;
  credits: number;
  startingFaction: string;
  shipCount: number;
}

export type SightingSource = "live" | "snapshot" | "baseline";

export interface Sighting {
  agent: string;
  system: string;
  hq: string;
  faction?: string;
  firstSeenAt: number;
  source: SightingSource;
  priorScanAt?: number;
  firstCredits: number;
  firstShips: number;
  agentsInSystem: number;
  lastSeenAt: number;
  lastCredits: number;
  lastShips: number;
}

/** "X1-VP49-A1" -> "X1-VP49". */
export function systemOfHq(hq: string): string {
  return hq.split("-").slice(0, 2).join("-");
}

export interface ScanPlan {
  /** Agents not seen before in this reset. */
  inserts: Sighting[];
  /** Agents already known, with what to refresh. */
  touches: { agent: string; at: number; credits: number; ships: number; faction: string; hq: string }[];
  /** Known agents missing from this scan (a shorter list than before: reported, never deleted). */
  missing: string[];
}

/**
 * Compare a full agent list with what is already recorded.
 * `bracketStart` is the end of the previous scan of this reset, when there was one: the time before which a new agent
 * cannot have been registered. With none (the watcher's first scan of a reset and nothing earlier on record), every new
 * agent is a baseline sighting.
 */
export function planScan(known: ReadonlyMap<string, Pick<Sighting, "lastSeenAt">>, agents: readonly PublicAgent[], now: number, bracketStart: number | undefined): ScanPlan {
  const perSystem = new Map<string, number>();
  for (const a of agents) {
    const s = systemOfHq(a.headquarters);
    perSystem.set(s, (perSystem.get(s) ?? 0) + 1);
  }
  const inserts: Sighting[] = [];
  const touches: ScanPlan["touches"] = [];
  const seen = new Set<string>();
  for (const a of agents) {
    seen.add(a.symbol);
    if (known.has(a.symbol)) {
      touches.push({ agent: a.symbol, at: now, credits: a.credits, ships: a.shipCount, faction: a.startingFaction, hq: a.headquarters });
      continue;
    }
    const system = systemOfHq(a.headquarters);
    inserts.push({
      agent: a.symbol, system, hq: a.headquarters, faction: a.startingFaction, firstSeenAt: now,
      source: bracketStart === undefined ? "baseline" : "live",
      ...(bracketStart === undefined ? {} : { priorScanAt: bracketStart }),
      firstCredits: a.credits, firstShips: a.shipCount, agentsInSystem: perSystem.get(system) ?? 1,
      lastSeenAt: now, lastCredits: a.credits, lastShips: a.shipCount,
    });
  }
  return { inserts, touches, missing: [...known.keys()].filter((k) => !seen.has(k)) };
}

export interface GateKnown {
  sampledAt: number;
  complete: boolean;
}

export interface GatePolicy {
  /** An unfinished gate is read again after this long. */
  recheckMs: number;
  /** Most gates read in one scan, so a slow API never stretches a scan out. */
  maxPerScan: number;
}

export const DEFAULT_GATE_POLICY: GatePolicy = { recheckMs: 30 * 60_000, maxPerScan: 60 };

/**
 * Which start-system gates to read now, most urgent first. A gate never sampled comes first (a new agent's start is read at
 * once, so its gate state at first sight is on record). A gate known finished is final and never read again; one known
 * unfinished is read again once its last sample is older than `recheckMs`, oldest first. `urgent` systems (a new agent
 * just appeared there) are read at once unless their gate is finished.
 */
export function gatesDue(systems: readonly string[], lastByGate: ReadonlyMap<string, GateKnown>, gateOfSystem: ReadonlyMap<string, string>, now: number, policy: GatePolicy = DEFAULT_GATE_POLICY, urgent: ReadonlySet<string> = new Set()): { system: string; gate: string | undefined }[] {
  const fresh: { system: string; gate: string | undefined }[] = [];
  const stale: { system: string; gate: string; at: number }[] = [];
  for (const system of new Set(systems)) {
    const gate = gateOfSystem.get(system);
    if (gate === undefined) { fresh.push({ system, gate: undefined }); continue; } // gate symbol not known yet: look it up
    const k = lastByGate.get(gate);
    if (!k) { fresh.push({ system, gate }); continue; }
    if (k.complete) continue;
    // A system a new agent just appeared in is read now, so its gate at first sight is on record.
    if (urgent.has(system)) { fresh.push({ system, gate }); continue; }
    if (now - k.sampledAt >= policy.recheckMs) stale.push({ system, gate, at: k.sampledAt });
  }
  stale.sort((a, b) => a.at - b.at);
  return [...fresh, ...stale.map(({ system, gate }) => ({ system, gate }))].slice(0, policy.maxPerScan);
}

export interface GateSample {
  sampledAt: number;
  fulfilled: number;
  required: number;
  complete: boolean;
}

/** Whether a new reading is worth a row: the first one, a change in what has been supplied, or the gate finishing. */
export function gateSampleChanged(prev: Pick<GateSample, "fulfilled" | "complete"> | undefined, cur: Pick<GateSample, "fulfilled" | "complete">): boolean {
  return !prev || prev.fulfilled !== cur.fulfilled || prev.complete !== cur.complete;
}

/** The newest sample at or before `t` (samples in time order), or undefined when the first one is later. */
export function gateAtOrBefore<T extends { sampledAt: number }>(samples: readonly T[], t: number): T | undefined {
  let best: T | undefined;
  for (const s of samples) {
    if (s.sampledAt <= t) best = s;
    else break;
  }
  return best;
}

/** When a gate finished, and how long after the first sample (the start of the watch), from its samples in time order. */
export function gateBuildTime(samples: readonly GateSample[]): { firstAt: number; completedAt: number; hours: number } | undefined {
  const first = samples[0];
  const done = samples.find((s) => s.complete);
  if (!first || !done) return undefined;
  return { firstAt: first.sampledAt, completedAt: done.sampledAt, hours: Math.round(((done.sampledAt - first.sampledAt) / 3_600_000) * 10) / 10 };
}
