/**
 * Box CPU on the admin health board, and the alert that says a restart may be due (operator 2026-11-27: "maybe we need an
 * alert for when the CPU gets to a certain percentage indicating that we might need to restart").
 *
 * Evidence it is worth watching: on 2026-11-27 the process that had run 12 h sat at about 106% CPU (the dispatcher
 * recompute rising about 100 ms an hour); the one that replaced it at 05:10 ran at about 56%.
 *
 * Pure: the caller samples process.cpuUsage() and the event-loop delay and passes them in. The share is CPU seconds over
 * wall seconds for the whole process (worker threads count), so 100% is one core fully used: the engine's main thread
 * is a single thread, so a share near 100% means it has no slack left.
 */
import type { HealthLevel, Tile } from "./serverHealth.js";

export interface CpuSample {
  /** Wall clock, ms. */
  at: number;
  /** process.cpuUsage() user + system, microseconds since the process started. */
  cpuUs: number;
}

export interface CpuPolicy {
  /** The share is measured over this window. */
  windowMs: number;
  /** CPU share (1 = one core) at which the tile warns / reads bad. */
  warnShare: number;
  badShare: number;
  /** Event-loop delay p99 (ms) at which the tile warns / reads bad, whatever the CPU share. */
  loopWarnMs: number;
  loopBadMs: number;
}

export const DEFAULT_CPU_POLICY: CpuPolicy = { windowMs: 10 * 60_000, warnShare: 0.85, badShare: 0.95, loopWarnMs: 500, loopBadMs: 2_000 };

/** Keep only the samples a window needs (plus one older, so the window has a start). Returns a new array. */
export function trimCpuSamples(samples: readonly CpuSample[], now: number, windowMs: number): CpuSample[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  let first = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.at <= now - windowMs) first = i;
  return sorted.slice(first);
}

/** CPU share over the window: CPU time used / wall time between the oldest usable sample and the newest. Null with under 2 samples or under a minute of span. */
export function cpuShare(samples: readonly CpuSample[], now: number, windowMs: number): { share: number; spanMs: number } | null {
  const s = trimCpuSamples(samples, now, windowMs);
  if (s.length < 2) return null;
  const a = s[0]!, b = s[s.length - 1]!;
  const spanMs = b.at - a.at;
  if (spanMs < 60_000) return null;
  return { share: Math.max(0, (b.cpuUs - a.cpuUs) / 1000 / spanMs), spanMs };
}

export interface CpuInput {
  /** From cpuShare(); null while the window is still filling. */
  share: number | null;
  spanMs: number | null;
  /** Event-loop delay p99 over the last minute, ms; null if not measured. */
  loopP99Ms: number | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** The CPU tile. Bad when the share or the event-loop delay reads bad. */
export function cpuTile(c: CpuInput | null | undefined, p: CpuPolicy = DEFAULT_CPU_POLICY): Tile {
  if (!c || c.share === null) {
    return { key: "cpu", label: "Box CPU", value: "—", word: "MEASURING", level: "ok", detail: `Needs ${mins(p.windowMs)} of samples after a restart.` };
  }
  const shareLevel: HealthLevel = c.share >= p.badShare ? "bad" : c.share >= p.warnShare ? "warn" : "ok";
  const loopLevel: HealthLevel = c.loopP99Ms === null ? "ok" : c.loopP99Ms >= p.loopBadMs ? "bad" : c.loopP99Ms >= p.loopWarnMs ? "warn" : "ok";
  const level: HealthLevel = shareLevel === "bad" || loopLevel === "bad" ? "bad" : shareLevel === "warn" || loopLevel === "warn" ? "warn" : "ok";
  const loop = c.loopP99Ms === null ? "" : `; event-loop delay p99 ${Math.round(c.loopP99Ms)} ms (warn ${p.loopWarnMs}, bad ${p.loopBadMs})`;
  return {
    key: "cpu", label: `Box CPU (last ${mins(c.spanMs ?? p.windowMs)})`, value: pct(c.share),
    word: level === "bad" ? "HOT" : level === "warn" ? "BUSY" : "OK", level,
    detail: `Process CPU, 100% = one core; warn at ${pct(p.warnShare)}, bad at ${pct(p.badShare)}${loop}.` +
      (level !== "ok" ? " A restart in a quiet moment cleared it on 2026-11-27 (106% at 12 h uptime, 56% after)." : ""),
  };
}

export interface CpuAlertState {
  /** When the tile first read bad in this hot spell; null when it is not bad. */
  hotSince: number | null;
  announced: boolean;
  lastAlertAt: number | null;
}

export const EMPTY_CPU_ALERT: CpuAlertState = { hotSince: null, announced: false, lastAlertAt: null };

export interface CpuAlertDecision {
  alert: boolean;
  state: CpuAlertState;
  reason: string;
  title?: string;
  body?: string;
}

/**
 * Alert once per hot spell, after the tile has read bad for `holdMs` running, and never twice within `cooldownMs`.
 * `uptimeMs` goes into the text, since the useful question is whether a restart is due.
 */
export function decideCpuAlert(state: CpuAlertState, tile: Tile, uptimeMs: number, now: number, holdMs: number, cooldownMs: number): CpuAlertDecision {
  if (tile.level !== "bad") return { alert: false, state: { hotSince: null, announced: false, lastAlertAt: state.lastAlertAt }, reason: state.hotSince !== null ? "cooled down" : "not hot" };
  const hotSince = state.hotSince ?? now;
  const next = { ...state, hotSince };
  if (now - hotSince < holdMs) return { alert: false, state: next, reason: `hot for ${mins(now - hotSince)}, alert after ${mins(holdMs)}` };
  if (state.announced) return { alert: false, state: next, reason: "this hot spell was already announced" };
  if (state.lastAlertAt !== null && now - state.lastAlertAt < cooldownMs) return { alert: false, state: next, reason: `cool-down: last alert ${mins(now - state.lastAlertAt)} ago` };
  const h = Math.floor(uptimeMs / 3_600_000);
  return {
    alert: true,
    state: { hotSince, announced: true, lastAlertAt: now },
    reason: "hot spell held",
    title: `Box CPU ${tile.value}: restart may be due`,
    body: `The server process has read ${tile.word} (${tile.value} CPU) for ${mins(now - hotSince)}, at ${h} h uptime. A restart in a quiet moment usually clears it.`,
  };
}
