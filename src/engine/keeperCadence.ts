/** Keeper poll spacing: a third of the time the market has sat unchanged, between 5 and 30 minutes. */
export const KEEPER_POLL_MIN_MS = 5 * 60_000;
export const KEEPER_POLL_MAX_MS = 30 * 60_000;

export function keeperPollDelayMs(idleMs: number): number {
  return Math.min(KEEPER_POLL_MAX_MS, Math.max(KEEPER_POLL_MIN_MS, Math.round(idleMs / 3)));
}
