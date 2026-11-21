/**
 * Worker-thread entry for the dispatcher recompute (issue #70). Each message is one job: the main thread's exported
 * dispatcher state, the dispatch world and the recompute inputs. The worker rebuilds a dispatcher from the state, runs
 * the recompute and sends the resulting state back with the log lines it wrote. It keeps nothing between jobs.
 */
import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { RouteDispatcher } from "./dispatcher.js";
import { exportDispatcherState, importDispatcherState, type DispatcherState } from "./dispatcherState.js";
import { runDispatchJob, type DispatchJob, type DispatchJobResult } from "./dispatchJob.js";
import type { DispatchWorld } from "./dispatchWorld.js";

parentPort?.on("message", (msg: { id: number; state: DispatcherState; world: DispatchWorld; job: DispatchJob }) => {
  const started = performance.now();
  const logs: string[] = [];
  let memoryChanged = false;
  let result: DispatchJobResult;
  try {
    const d = new RouteDispatcher();
    importDispatcherState(d, msg.state);
    d.setLogger((m) => logs.push(m));
    d.setOnMemoryChange(() => { memoryChanged = true; });
    runDispatchJob(d, msg.job, msg.world, (m) => logs.push(m));
    result = { id: msg.id, ok: true, state: exportDispatcherState(d), logs, memoryChanged, ms: performance.now() - started };
  } catch (err) {
    result = { id: msg.id, ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err), logs, memoryChanged, ms: performance.now() - started };
  }
  parentPort?.postMessage(result);
});
