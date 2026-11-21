import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where a scheduler task's time goes (issue #66). A task runs inside `runWithStepTimer()`, and the few places that wait
 * on something outside the process note their elapsed time into whatever timer the running async context carries:
 * the API client (`api.wait` in the rate limiter, `api.request` on the wire, `api.backoff` sleeping before a retry) and
 * the database pool (`db.wait` for a free connection, `db.query` while holding one). What is left of the task's wall
 * time is "other": in-process work and every await not counted above.
 *
 * Telemetry only: outside a timer every call here is a no-op, and nothing reads these figures to decide anything.
 */
export class StepTimer {
  readonly ms: Record<string, number> = {};
  readonly counts: Record<string, number> = {};

  add(step: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.ms[step] = (this.ms[step] ?? 0) + ms;
    this.counts[step] = (this.counts[step] ?? 0) + 1;
  }
}

const timerContext = new AsyncLocalStorage<StepTimer>();

/** Run `fn` with `timer` collecting every step noted inside it, its awaited descendants included. */
export function runWithStepTimer<T>(timer: StepTimer, fn: () => Promise<T>): Promise<T> {
  return timerContext.run(timer, fn);
}

/** Add `ms` to `step` on the running context's timer, if there is one. Never throws. */
export function noteStep(step: string, ms: number): void {
  timerContext.getStore()?.add(step, ms);
}
