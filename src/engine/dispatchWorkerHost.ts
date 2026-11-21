/**
 * Runs the dispatcher recompute on a worker thread (issue #70, clause dispatcherWorker). The main thread exports the
 * dispatcher's state, posts it with the dispatch world and the inputs, and keeps serving everything else while the
 * worker computes. When the result comes back it is merged with whatever the main thread changed meanwhile
 * (dispatcherState.ts: a claim, decline or sale made during the wait is kept) and installed, and the worker's log lines
 * are written as if the recompute had run here.
 *
 * Safety: one job at a time. A worker error runs that cycle in-thread instead (the same runDispatchJob() code). A worker
 * that does not answer within the timeout is terminated and replaced, and that cycle is skipped (traders keep their
 * current routes and claims keep working on the previous list); after `maxMisses` misses in a row the next cycle runs
 * in-thread, so a broken worker can never stop dispatching altogether.
 */
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import type { RouteDispatcher } from "./dispatcher.js";
import { exportDispatcherState, importDispatcherState, mergeDispatcherState } from "./dispatcherState.js";
import { runDispatchJob, type DispatchJob, type DispatchJobResult } from "./dispatchJob.js";
import type { DispatchWorld } from "./dispatchWorld.js";

export interface DispatchOutcome {
  /** worker: computed off-thread and merged. inThread: ran here (worker error or too many misses). skipped: throttled or
   *  a job already in flight. timeout: no answer in time, cycle skipped. */
  path: "worker" | "inThread" | "skipped" | "timeout";
  /** Main-thread time spent on this cycle (export, merge, import; or the whole recompute in-thread). */
  mainMs: number;
  /** Time the worker spent in the recompute. */
  workerMs?: number;
  /** Recompute assignments dropped because a main-thread claim took the same good meanwhile. */
  dropped: string[];
  reason?: string;
}

export interface HostOptions {
  timeoutMs?: number;
  maxMisses?: number;
  /** Override the worker script (tests). */
  workerUrl?: URL;
}

const defaultWorkerUrl = (): URL => new URL(import.meta.url.endsWith(".ts") ? "./dispatchWorkerMain.ts" : "./dispatchWorkerMain.js", import.meta.url);

export class DispatchWorkerHost {
  private worker: Worker | undefined;
  private nextId = 1;
  private inFlight = false;
  private misses = 0;
  private readonly pending = new Map<number, (r: DispatchJobResult) => void>();
  private readonly timeoutMs: number;
  private readonly maxMisses: number;
  private readonly workerUrl: URL;

  constructor(opts: HostOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxMisses = opts.maxMisses ?? 3;
    this.workerUrl = opts.workerUrl ?? defaultWorkerUrl();
  }

  /** Is a recompute running in the worker right now? */
  busy(): boolean { return this.inFlight; }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerUrl, { execArgv: process.execArgv.filter((a) => !a.startsWith("--inspect")) });
    w.on("message", (r: DispatchJobResult) => { this.pending.get(r.id)?.(r); this.pending.delete(r.id); });
    const fail = (why: string): void => {
      for (const [id, resolve] of this.pending) resolve({ id, ok: false, error: why, logs: [], memoryChanged: false, ms: 0 });
      this.pending.clear();
      if (this.worker === w) this.worker = undefined;
    };
    w.on("error", (err) => fail(`worker error: ${err instanceof Error ? err.message : String(err)}`));
    w.on("exit", (code) => fail(`worker exited (${code})`));
    w.unref();
    this.worker = w;
    return w;
  }

  /** Stop the worker (shutdown, tests). */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }

  /**
   * One recompute. Resolves once the result is installed on `dispatcher` (or the cycle was run in-thread, skipped or
   * timed out). The main thread is free while it waits.
   */
  async run(dispatcher: RouteDispatcher, job: DispatchJob, world: DispatchWorld, log: (m: string) => void, now: number = Date.now()): Promise<DispatchOutcome> {
    if (this.inFlight) return { path: "skipped", mainMs: 0, dropped: [], reason: "a recompute is already running in the worker" };
    if (!dispatcher.recomputeDue(now)) return { path: "skipped", mainMs: 0, dropped: [], reason: "throttled (once a minute)" };
    if (this.misses >= this.maxMisses) {
      this.misses = 0;
      return this.inThread(dispatcher, job, world, log, `${this.maxMisses} worker misses in a row`);
    }
    this.inFlight = true;
    let mainMs = 0;
    try {
      let t = performance.now();
      const before = exportDispatcherState(dispatcher);
      const id = this.nextId++;
      const worker = this.spawn();
      const answer = new Promise<DispatchJobResult | undefined>((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve(undefined); }, this.timeoutMs);
        timer.unref?.();
        this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      });
      worker.ref();
      worker.postMessage({ id, state: before, world, job });
      mainMs += performance.now() - t;
      const result = await answer;
      worker.unref();
      if (!result) {
        this.misses += 1;
        await this.close();
        return { path: "timeout", mainMs, dropped: [], reason: `no answer from the worker in ${Math.round(this.timeoutMs / 1000)} s; cycle skipped, worker restarted` };
      }
      if (!result.ok || !result.state) {
        this.misses += 1;
        const fallback = this.inThread(dispatcher, job, world, log, `worker failed: ${(result.error ?? "no state").split("\n")[0]}`);
        fallback.mainMs += mainMs;
        return fallback;
      }
      this.misses = 0;
      t = performance.now();
      const { state, dropped } = mergeDispatcherState(before, exportDispatcherState(dispatcher), result.state);
      importDispatcherState(dispatcher, state);
      for (const line of result.logs) log(line);
      if (dropped.length > 0) log(`dispatch worker: dropped ${dropped.join(", ")} (a claim on this thread took the same good while the recompute ran)`);
      if (result.memoryChanged) dispatcher.notifyMemoryChanged();
      mainMs += performance.now() - t;
      return { path: "worker", mainMs, workerMs: result.ms, dropped };
    } finally {
      this.inFlight = false;
    }
  }

  private inThread(dispatcher: RouteDispatcher, job: DispatchJob, world: DispatchWorld, log: (m: string) => void, reason: string): DispatchOutcome {
    const t = performance.now();
    runDispatchJob(dispatcher, job, world, log);
    return { path: "inThread", mainMs: performance.now() - t, dropped: [], reason };
  }
}
