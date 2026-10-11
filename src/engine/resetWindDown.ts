/**
 * Reset wind-down: the stretch before a weekly universe reset when nothing new is bought and every hold is sold, so the
 * fleet ends the week holding credits rather than cargo.
 *
 * Pure: the caller supplies the clock, the next reset time and the doctrine policy. Off by default (the policy's
 * `enabled` flag), so with it off this changes nothing.
 */

export interface WindDownPolicy {
  /** The "Reset wind-down" clause's switch. */
  enabled: boolean;
  /** How long before the reset the window opens, in minutes. */
  minutes: number;
}

export interface WindDownState {
  /** True while no new buy may start. Selling is never blocked. */
  active: boolean;
  /** One line for the log and the dashboard: why the window is or isn't open. */
  reason: string;
}

/**
 * Whether the wind-down window is open at `nowMs`.
 *
 * Open from `minutes` before the reset until the reset itself. After the reset has passed it is closed, so a stale
 * reset time from the old universe can't keep the fleet idle; the reset watcher moves nextReset forward once the new
 * universe is confirmed.
 */
export function windDown(nowMs: number, resetAtMs: number | undefined, policy: WindDownPolicy): WindDownState {
  if (!policy.enabled) return { active: false, reason: "reset wind-down is off" };
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) {
    return { active: false, reason: "the next reset is not known yet" };
  }
  const minutesLeft = (resetAtMs - nowMs) / 60_000;
  if (minutesLeft <= 0) return { active: false, reason: "the reset has passed" };
  if (minutesLeft > policy.minutes) {
    return { active: false, reason: `reset in ${Math.round(minutesLeft)} min, wind-down opens at ${policy.minutes} min` };
  }
  return { active: true, reason: `reset in ${Math.ceil(minutesLeft)} min: no new buys, selling what is held` };
}
