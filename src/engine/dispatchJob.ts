/**
 * One dispatcher recompute as plain data, and running it (issue #70, stage 3). The worker thread runs runDispatchJob()
 * on a fresh RouteDispatcher given the main thread's exported state; the same function is the in-thread fallback, so the
 * two paths cannot drift apart. The six live callbacks recompute() normally takes are rebuilt from the DispatchWorld.
 */
import type { RouteDispatcher } from "./dispatcher.js";
import { worldCallbacks, type DispatchWorld } from "./dispatchWorld.js";

type RecomputeArgs = Parameters<RouteDispatcher["recompute"]>;

export interface DispatchJob {
  routes: RecomputeArgs[0];
  traders: RecomputeArgs[1];
  warehouseTargets: NonNullable<RecomputeArgs[2]>;
  haulTargets: NonNullable<RecomputeArgs[3]>;
  missionBuyTargets: NonNullable<RecomputeArgs[4]>;
  contractBuyTargets: NonNullable<RecomputeArgs[5]>;
  /** crossSystem without its callbacks (they come from the world). */
  crossSystem: { enabled: boolean; homeSystem?: string; homeReserve?: number };
  tuning: RecomputeArgs[11];
  inFlight: RecomputeArgs[12];
}

/** Run the job's recompute on `dispatcher`, answering every galaxy question from `world`. Log lines go to `log`. */
export function runDispatchJob(dispatcher: RouteDispatcher, job: DispatchJob, world: DispatchWorld, log: (m: string) => void): void {
  const cb = worldCallbacks(world);
  dispatcher.recompute(
    job.routes,
    job.traders,
    job.warehouseTargets,
    job.haulTargets,
    job.missionBuyTargets,
    job.contractBuyTargets,
    cb.canJump,
    cb.distanceBetween,
    log,
    cb.hasFuelStop,
    { ...job.crossSystem, path: cb.path, hopCost: cb.hopCost, gateFor: cb.gateFor },
    job.tuning,
    job.inFlight,
  );
}

/** What the worker sends back. */
export interface DispatchJobResult {
  id: number;
  ok: boolean;
  error?: string;
  state?: Record<string, unknown>;
  logs: string[];
  memoryChanged: boolean;
  ms: number;
}
