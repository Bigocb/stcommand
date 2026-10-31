/**
 * When to stage and release the next fresh system (docs/fresh-system-expansion-plan.md, "Queued systems and the release gate").
 *
 * One decision function serves all three modes of the `freshGate` clause: off decides nothing, advisory returns what the engine
 * would do (shown to the operator, who flips by hand), auto returns the same and the caller acts on it. A manual release or hold
 * never goes through here; a hold pins a system against this function.
 *
 * The rule, in words: keep `target` systems with a live premium that is not about to fade. A live system is "alive" until its age
 * passes `fadeMs` or its recent profit per unit falls under `fadeRatio` times the mature rate; it is "fading soon" once its age is
 * within `leadMs` of `fadeMs`. When alive-and-not-fading-soon systems number fewer than the target, release the best ready staged
 * system. Traders left idle for too long release one regardless of the target. Staging runs ahead of need so a system is ready when
 * wanted: the oldest scouted system is staged whenever fewer than `stagedAhead` systems are staged and there is budget for its keepers.
 *
 * Pure: no I/O, no clock. Missing information never releases anything. Every decision carries a one-line reason.
 */

export type ReleaseMode = "off" | "advisory" | "auto";

export interface ReleasePolicy {
  mode: ReleaseMode;
  /** Live-premium systems to hold at once. */
  target: number;
  /** Release this long before the newest cohort is expected to fade. The operator's main knob. */
  leadMs: number;
  /** Age at which a system's premium is expected to be gone (the 2026-10-24 curve: full to about 8h, 1.2x to 16h). */
  fadeMs: number;
  /** A live system whose recent profit per unit is under this multiple of the mature rate is faded. */
  fadeRatio: number;
  /** Fewest sells in the recent window before a ratio is believed. */
  minSells: number;
  /** Fewest ms between two releases (idle traders excepted). */
  minGapMs: number;
  /** Idle traders at or above this release one regardless of the target; 0 = off. */
  idleTradersMax: number;
  /** Staged systems to keep ready ahead of need. */
  stagedAhead: number;
  /** A live system older than `graceMs` counts toward the target only with at least this many recent sells; 0 = off (age alone counts). */
  minTradingSells: number;
  /** How long after its release a system counts without sells, while traders find it. */
  graceMs: number;
}

const H = 3_600_000;

export const DEFAULT_RELEASE_POLICY: ReleasePolicy = {
  mode: "off",
  target: 3,
  leadMs: 4 * H,
  fadeMs: 10 * H,
  fadeRatio: 1.25,
  minSells: 15,
  minGapMs: 30 * 60_000,
  idleTradersMax: 3,
  stagedAhead: 1,
  minTradingSells: 0,
  graceMs: 3 * H,
};

export interface QueueFacts {
  system: string;
  state: "scouted" | "staged";
  held: boolean;
  addedAt: number;
  stagedAt?: number;
  /** Keepers it needs, i.e. how many markets are in its list. */
  markets: number;
  /** Staged only: keepers stationed (and parked) over markets; 1 = all of them. */
  readyShare?: number;
  /**
   * Can our ships gate to it over finished gates? false = no: a keeper probe cannot be delivered, so it is never staged and a
   * staged one does not hold a "staged ahead" place (2026-10-30: AV28, BR8 and KN88, gates unfinished, sat staged with no keeper for
   * hours and kept every reachable system out). undefined = not known, treated as reachable.
   */
  reachable?: boolean;
}

export interface LiveFacts {
  system: string;
  releasedAt: number;
  /** Recent profit per unit over the mature rate; null = too few sells to say. */
  ratio: number | null;
  sells: number;
}

export interface ReleaseSignals {
  now: number;
  queue: readonly QueueFacts[];
  live: readonly LiveFacts[];
  idleTraders: number;
  /** Keeper slots left under keeperMaxTotal; null = no limit. */
  budgetRoom: number | null;
  lastReleaseAt?: number;
}

export interface ReleaseDecision {
  stage: { system: string; reason: string }[];
  release: { system: string; reason: string }[];
  /** Why nothing (more) was done, for the operator. */
  notes: string[];
}

/** Share of staged keepers that must be in place before a system counts as ready. */
export const READY_SHARE = 0.8;

export function aliveState(l: LiveFacts, now: number, p: ReleasePolicy): "alive" | "fading-soon" | "faded" {
  const age = now - l.releasedAt;
  if (age >= p.fadeMs) return "faded";
  if (l.ratio !== null && l.sells >= p.minSells && l.ratio < p.fadeRatio) return "faded";
  return age >= p.fadeMs - p.leadMs ? "fading-soon" : "alive";
}

/** A system that is alive by age but that nobody trades in yet no longer holds a place in the target (clause freshTradingSells). */
export function idleLive(l: LiveFacts, now: number, p: ReleasePolicy): boolean {
  return p.minTradingSells > 0 && now - l.releasedAt >= p.graceMs && l.sells < p.minTradingSells;
}

export function decideReleases(s: ReleaseSignals, p: ReleasePolicy): ReleaseDecision {
  const out: ReleaseDecision = { stage: [], release: [], notes: [] };
  if (p.mode === "off") return out;

  const states = s.live.map((l) => ({ l, st: aliveState(l, s.now, p) }));
  const alive = states.filter((x) => x.st === "alive" && !idleLive(x.l, s.now, p)).length;
  const untraded = states.filter((x) => x.st === "alive" && idleLive(x.l, s.now, p)).length;
  const soon = states.filter((x) => x.st === "fading-soon").length;
  const eligible = (q: QueueFacts) => !q.held;
  const reachable = (q: QueueFacts) => q.reachable !== false;

  // Stage ahead of need.
  const staged = s.queue.filter((q) => q.state === "staged");
  const stagedCount = staged.filter(reachable).length;
  let budget = s.budgetRoom;
  if (stagedCount < p.stagedAhead) {
    const next = s.queue.filter((q) => q.state === "scouted" && eligible(q) && reachable(q)).sort((a, b) => a.addedAt - b.addedAt)[0];
    if (next) {
      if (budget !== null && budget < next.markets) out.notes.push(`${next.system} is next to stage but needs ${next.markets} keeper slot(s) and ${budget} are free`);
      else {
        out.stage.push({ system: next.system, reason: `${stagedCount} staged, ${p.stagedAhead} wanted ahead of need; ${next.markets} keeper(s) to buy` });
        if (budget !== null) budget -= next.markets;
      }
    } else if (!s.queue.some((q) => q.state === "scouted")) out.notes.push("no scouted system waiting to be staged");
    else if (s.queue.some((q) => q.state === "scouted" && eligible(q))) out.notes.push("no scouted system can be reached over finished gates yet");
    else out.notes.push("every scouted system is held");
  }

  // Release.
  const idle = p.idleTradersMax > 0 && s.idleTraders >= p.idleTradersMax;
  const covered = alive; // systems with a premium that is not about to fade
  const short = p.target - covered;
  const wantRelease = idle || short > 0;
  if (!wantRelease) {
    out.notes.push(`${covered} live premium system(s) not fading, target ${p.target}${soon ? `; ${soon} fading within the lead time` : ""}${untraded ? `; ${untraded} not counted (under ${p.minTradingSells} recent sells)` : ""}: no release needed`);
    return out;
  }
  const sinceLast = s.lastReleaseAt === undefined ? Infinity : s.now - s.lastReleaseAt;
  if (!idle && sinceLast < p.minGapMs) {
    out.notes.push(`last release was ${Math.round(sinceLast / 60_000)} min ago, minimum gap ${Math.round(p.minGapMs / 60_000)} min`);
    return out;
  }
  const ready = staged.filter((q) => eligible(q) && reachable(q) && (q.readyShare ?? 0) >= READY_SHARE).sort((a, b) => (b.readyShare ?? 0) - (a.readyShare ?? 0) || (a.stagedAt ?? 0) - (b.stagedAt ?? 0) || a.addedAt - b.addedAt);
  const pick = ready[0];
  if (!pick) {
    out.notes.push(
      `wanted a release (${idle ? `${s.idleTraders} idle trader(s)` : `${covered} of ${p.target} live premium systems`}) but no staged system is ready` +
        (staged.some((q) => q.held) ? " (a staged system is held)" : "") + (staged.length ? ` (staged: ${staged.map((q) => `${q.system} ${Math.round((q.readyShare ?? 0) * 100)}%`).join(", ")})` : ""),
    );
    return out;
  }
  const why = idle ? `${s.idleTraders} trader(s) idle, at or over ${p.idleTradersMax}` : `${covered} live premium system(s) not fading, target ${p.target}${soon ? `, ${soon} fading within ${Math.round(p.leadMs / 60_000)} min` : ""}${untraded ? `, ${untraded} not counted for lack of sales` : ""}`;
  out.release.push({ system: pick.system, reason: `${why}; ${pick.system} is ${Math.round((pick.readyShare ?? 0) * 100)}% ready` });
  return out;
}
