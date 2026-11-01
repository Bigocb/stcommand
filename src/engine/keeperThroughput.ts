// How fast the keepers are actually reading markets, measured, and what that means for adding more.
//
// Two different numbers were being mixed up (2026-11-01). The top-up's load figure is DEMAND: the calls a minute the keepers
// would make if each read on its own cadence (5-30 minutes), about 75 for 600 keepers. What the API pipe lets them do is
// SUPPLY: measured 13-16 reads a minute that day, because traders are served first. Demand above supply does not make the
// model wrong, it means a rotation over every keeper takes (keepers / reads a minute) = about 45 minutes, not the 5-30 asked for.
// More keepers then lengthen the rotation for all of them. This module measures the supply and turns it into a rotation time.
//
// Pure: the clock is passed in.

export class ReadRate {
  private times: number[] = [];

  /** One keeper market read just completed. */
  note(nowMs: number): void {
    this.times.push(nowMs);
    if (this.times.length > 20_000) this.times.splice(0, this.times.length - 20_000);
  }

  /** Reads a minute over the last `windowMs`. */
  perMin(nowMs: number, windowMs = 10 * 60_000): number {
    const from = nowMs - windowMs;
    let n = 0;
    for (let i = this.times.length - 1; i >= 0; i--) {
      if ((this.times[i] as number) < from) break;
      n += 1;
    }
    return n / (windowMs / 60_000);
  }
}

/**
 * Minutes for the keepers to read every market once at the measured rate, or undefined when it cannot be judged: nothing read yet,
 * or the process started less than a window ago (a restart's first minutes read little and say nothing about the pace).
 */
export function rotationMin(keepers: number, readsPerMin: number, sinceBootMs: number, windowMs = 10 * 60_000): number | undefined {
  if (sinceBootMs < windowMs) return undefined;
  if (!(readsPerMin > 0) || keepers <= 0) return undefined;
  return Math.round((keepers / readsPerMin) * 10) / 10;
}
