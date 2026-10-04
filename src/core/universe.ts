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
