/**
 * What the container and the process look like from the inside, and how each recent process ended (operator 2026-11-21: the
 * box restarted at 20:40 with no deploy, and nobody in a cloud session can run `docker inspect`).
 *
 * Two parts, both pure:
 *  - parseCgroupMemory(): the container's memory limit, current and peak use, and its OOM-kill counter, from the cgroup files
 *    (v2: memory.max, memory.current, memory.peak, memory.events, memory.stat; v1: memory.limit_in_bytes, memory.usage_in_bytes,
 *    memory.max_usage_in_bytes, memory.oom_control, memory.stat). The caller reads the files; a file it could not read is undefined.
 *  - classifyEnd(): given one process's last heartbeat (its memory at the time) and the process that came after it, why it most
 *    likely ended: a deploy (the next one runs newer code), a JS heap OOM (heap within 10% of V8's limit), a container OOM (resident
 *    memory within 10% of the cgroup limit), or unknown. It is a likelihood from the last sample, not proof: the heartbeat is every
 *    10 s, so the final seconds are not seen. Say so when reporting it.
 */

export interface CgroupFiles {
  v2?: { max?: string; current?: string; peak?: string; events?: string; stat?: string };
  v1?: { limit?: string; usage?: string; maxUsage?: string; oomControl?: string; stat?: string };
}

export interface CgroupMemory {
  version: "v2" | "v1" | "none";
  /** null = no limit set (the host's memory is the only limit). */
  limitBytes: number | null;
  currentBytes: number | null;
  /** Highest use since the cgroup was created, where the kernel keeps it. */
  peakBytes: number | null;
  /** Times the kernel's OOM killer killed something in this cgroup (since it was created). */
  oomKills: number | null;
  /** Times the cgroup hit its limit (v2 memory.events "oom"). */
  oomEvents: number | null;
  anonBytes: number | null;
  fileBytes: number | null;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || t === "max") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** `key value` lines (memory.events, memory.stat, memory.oom_control) as a map. */
export function keyValues(text: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of (text ?? "").split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && Number.isFinite(Number(v))) out.set(k, Number(v));
  }
  return out;
}

/** A v1 "no limit" is a huge number (page-rounded 2^63); treat anything over 2^60 as unlimited. */
const UNLIMITED_V1 = 2 ** 60;

export function parseCgroupMemory(files: CgroupFiles): CgroupMemory {
  const v2 = files.v2;
  if (v2 && (v2.current !== undefined || v2.max !== undefined)) {
    const events = keyValues(v2.events);
    const stat = keyValues(v2.stat);
    return {
      version: "v2",
      limitBytes: num(v2.max),
      currentBytes: num(v2.current),
      peakBytes: num(v2.peak),
      oomKills: events.has("oom_kill") ? events.get("oom_kill")! : null,
      oomEvents: events.has("oom") ? events.get("oom")! : null,
      anonBytes: stat.get("anon") ?? null,
      fileBytes: stat.get("file") ?? null,
    };
  }
  const v1 = files.v1;
  if (v1 && (v1.usage !== undefined || v1.limit !== undefined)) {
    const limit = num(v1.limit);
    const oom = keyValues(v1.oomControl);
    const stat = keyValues(v1.stat);
    return {
      version: "v1",
      limitBytes: limit !== null && limit < UNLIMITED_V1 ? limit : null,
      currentBytes: num(v1.usage),
      peakBytes: num(v1.maxUsage),
      oomKills: oom.has("oom_kill") ? oom.get("oom_kill")! : null,
      oomEvents: null,
      anonBytes: stat.get("total_rss") ?? stat.get("rss") ?? null,
      fileBytes: stat.get("total_cache") ?? stat.get("cache") ?? null,
    };
  }
  return { version: "none", limitBytes: null, currentBytes: null, peakBytes: null, oomKills: null, oomEvents: null, anonBytes: null, fileBytes: null };
}

/** One process's last heartbeat, as stored (instance_heartbeats, migration 070). Memory fields are absent on rows from older builds. */
export interface ProcessBeat {
  instanceId: string;
  startedAt: string;
  lastSeen: string;
  aliveNow: boolean;
  rssMb?: number | null;
  heapUsedMb?: number | null;
  heapLimitMb?: number | null;
  cgroupCurrentMb?: number | null;
  cgroupLimitMb?: number | null;
  oomKills?: number | null;
  build?: string | null;
  /** When the file the process ran from was written: a later process with a later time ran newer code. */
  codeMtime?: string | null;
}

export type EndKind = "running" | "deploy" | "heap_oom_likely" | "container_oom_likely" | "unknown";

export interface ProcessEnd {
  kind: EndKind;
  reason: string;
  /** Seconds from this process's last heartbeat to the next one's start: the time no process was running. */
  gapSec?: number;
}

const NEAR = 0.9;

/** Why `beat` ended, given the process that started after it (undefined = none yet). */
export function classifyEnd(beat: ProcessBeat, next: ProcessBeat | undefined): ProcessEnd {
  if (beat.aliveNow) return { kind: "running", reason: "still sending heartbeats" };
  const gapSec = next ? Math.round((Date.parse(next.startedAt) - Date.parse(beat.lastSeen)) / 1000) : undefined;
  const gap = gapSec !== undefined ? { gapSec } : {};
  const heapShare = beat.heapUsedMb && beat.heapLimitMb ? beat.heapUsedMb / beat.heapLimitMb : undefined;
  const cgShare = beat.rssMb && beat.cgroupLimitMb ? beat.rssMb / beat.cgroupLimitMb : undefined;
  if (next?.codeMtime && beat.codeMtime && Date.parse(next.codeMtime) > Date.parse(beat.codeMtime)) {
    return { kind: "deploy", reason: `the next process ran newer code (${next.build ?? "?"}, written ${next.codeMtime})`, ...gap };
  }
  if (next?.oomKills != null && beat.oomKills != null && next.oomKills > beat.oomKills) {
    return { kind: "container_oom_likely", reason: `the cgroup's OOM-kill counter rose from ${beat.oomKills} to ${next.oomKills}`, ...gap };
  }
  if (heapShare !== undefined && heapShare >= NEAR) {
    return { kind: "heap_oom_likely", reason: `last heartbeat had the JS heap at ${beat.heapUsedMb} of ${beat.heapLimitMb} MB (${Math.round(heapShare * 100)}%)`, ...gap };
  }
  if (cgShare !== undefined && cgShare >= NEAR) {
    return { kind: "container_oom_likely", reason: `last heartbeat had resident memory at ${beat.rssMb} of the container's ${beat.cgroupLimitMb} MB (${Math.round(cgShare * 100)}%)`, ...gap };
  }
  const mem = beat.heapUsedMb != null ? ` (last heartbeat: heap ${beat.heapUsedMb}/${beat.heapLimitMb ?? "?"} MB, rss ${beat.rssMb ?? "?"} MB)` : " (no memory figures: a build before migration 070)";
  return { kind: "unknown", reason: `same code, memory not near a limit at the last heartbeat${mem}`, ...gap };
}

/** Each process in start order with how it ended; newest last. */
export function processHistory(beats: readonly ProcessBeat[]): (ProcessBeat & { end: ProcessEnd })[] {
  const sorted = [...beats].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return sorted.map((b, i) => ({ ...b, end: classifyEnd(b, sorted[i + 1]) }));
}
