/**
 * Which game universe (the SpaceTraders `resetDate`) this process is currently
 * playing in. Set by the reset watcher once it knows; read by the code that
 * writes durable history (fleet_events / run_timeline) so each row can be
 * attributed to its week. 'unknown' until the watcher's first tick.
 */
let currentResetDate = "unknown";

export function setCurrentResetDate(resetDate: string): void {
  currentResetDate = resetDate;
}

export function getCurrentResetDate(): string {
  return currentResetDate;
}

/**
 * The reset date the game itself reports right now: which universe the game is in, updated on every status poll. Unlike
 * `currentResetDate` above, which follows the last reset the watcher HANDLED (and so stays on last week's date while the
 * watcher is disabled or waiting for an account token), this is the live fact. It is what a new ledger row belongs to,
 * because a row is written in whatever universe the game is in, whether or not anyone has cleaned up after the reset.
 * Undefined until the first poll succeeds.
 */
let gameResetDate: string | undefined;

export function setGameResetDate(resetDate: string): void {
  gameResetDate = resetDate;
}

export function getGameResetDate(): string | undefined {
  return gameResetDate;
}
