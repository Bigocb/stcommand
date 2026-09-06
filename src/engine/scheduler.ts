/**
 * The queue/runner/budget mechanics behind every ship's work: a priority task
 * queue, a per-tenant call budget, and a runner loop that drains ready tasks
 * within that budget, highest priority first, pausing everything but rescue
 * (priority 0) while the fleet is halted.
 *
 * This is live and load-bearing. Every agent is driven by a `nextTask()`
 * chain enqueued here from `FleetManager.syncSchedulerTasks()`; the blocking
 * per-agent loops this once sat alongside have been deleted, so there is no
 * other path by which a ship acts.
 *
 * One consequence shapes everything above it: `runOnce()` executes ready
 * tasks strictly sequentially, so a task that *waits* occupies the runner and
 * holds every other ship in the tenant, rescue included. That is why nothing
 * in the data plane may sleep — a transit, a cooldown or a backoff throws a
 * `Pending` carrying its real resume time instead, and the task is
 * rescheduled for exactly then. See agentStep.ts and
 * docs/control-plane-data-plane.md §5.
 */

export type Priority = 0 | 1 | 2 | 3 | 4; // 0 rescue · 1 mission · 2 trade · 3 survey/keeper · 4 telemetry

export interface TaskResult {
  next?: Task;
  actualCalls: number;
}

export interface Task {
  id: string;
  shipSymbol?: string;
  priority: Priority;
  estimatedCalls: number;
  earliestRunAt: number; // ms since epoch
  run(): Promise<TaskResult>;
}

/**
 * A token-bucket budget, same shape as `src/core/client.ts`'s own
 * `RateLimiter` but deliberately a separate instance: this one isn't what
 * actually throttles HTTP calls (the real `Client` still self-throttles
 * regardless, per-tenant, at the transport layer) — it's the scheduler's
 * own admission-control accounting, letting it decide up front which
 * *priority* of task gets to spend the fleet's call budget this pass,
 * before any of those calls are actually made. Two layers, not one
 * duplicating the other: this one is about *what* runs, the client's is
 * about *how fast*.
 */
export class SchedulerBudget {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  availableTokens(): number {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    return this.tokens;
  }

  consumeTokens(n: number): void {
    this.tokens = Math.max(0, this.tokens - n);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One per tenant. Holds a priority queue of `Task`s and a `SchedulerBudget`;
 * `run()` is a coordinator-style loop (same `while (running) { ...; await
 * sleep(...) }` shape as `FleetManager.run()`) that, each pass, admits
 * ready tasks highest-priority-first until the budget runs out, executes
 * them, trues up the budget from each result's `actualCalls`, and enqueues
 * any `next` step a task returns.
 */
export class Scheduler {
  private queue: Task[] = [];
  private budget: SchedulerBudget;
  private running = false;
  /** Injected rather than read from a store directly — keeps this class free of any Postgres/tenant dependency, same as ShipRegistry. */
  private isPaused: () => boolean;
  private readonly burst: number;
  private readonly log: (msg: string) => void;
  private readonly heartbeatMs: number;
  /**
   * Counters for the heartbeat below. Every one of them exists because a
   * failure of that kind was, at some point today, completely silent: a task
   * skipped for budget logged nothing, a task that threw logged nothing from
   * here, and a scheduler that ran zero tasks for forty minutes looked
   * exactly like one with nothing to do.
   */
  private stats = { ran: 0, skipped: 0, failed: 0, yielded: 0 };
  /** Consecutive passes each task has been skipped for budget, by task id. */
  private skips = new Map<string, number>();
  /** Task ids already reported as permanently unadmittable, so it is said once. */
  private starved = new Set<string>();
  private lastHeartbeat = Date.now();
  private lastRanAt = Date.now();

  constructor(opts: { ratePerSec?: number; burst?: number; isPaused?: () => boolean; log?: (msg: string) => void; heartbeatMs?: number } = {}) {
    // Matches Client's own RateLimiter (see client.ts's comment) — admitting
    // tasks faster than the transport layer can actually sustain just means
    // more of them arrive at the real 429 ceiling instead of waiting here.
    //
    // The burst must be at least as large as the biggest `estimatedCalls` any
    // task reports, or runOnce()'s `estimatedCalls > budget` admission check
    // permanently starves that task. The largest today is the rescue task
    // (estimatedCalls: 5); miners/traders/siphoners are 3. A burst of 5 lets
    // any single task be admitted; the Client's own limiter (burst 2) is what
    // actually paces the requests, so this doesn't reintroduce the 429 bursts.
    const rate = opts.ratePerSec ?? 1.5;
    this.burst = opts.burst ?? 5;
    this.budget = new SchedulerBudget(rate, this.burst);
    this.isPaused = opts.isPaused ?? (() => false);
    this.log = opts.log ?? (() => {});
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
  }

  enqueue(task: Task): void {
    this.queue.push(task);
  }

  size(): number {
    return this.queue.length;
  }

  /** One pass: admit and run every ready task the budget allows, highest priority first. Returns how many tasks ran. */
  async runOnce(): Promise<number> {
    const now = Date.now();
    const paused = this.isPaused();
    const ready = this.queue
      .filter((t) => t.earliestRunAt <= now)
      .filter((t) => (paused ? t.priority === 0 : true))
      .sort((a, b) => a.priority - b.priority || a.earliestRunAt - b.earliestRunAt);

    let ran = 0;
    for (const task of ready) {
      const budget = this.budget.availableTokens();
      if (task.estimatedCalls > budget) {
        // Skipping is silent by design — save the budget for a higher-priority
        // task later in this pass — and that silence is how a fleet can stand
        // still for forty minutes with no error anywhere. Count it, and say
        // something when a skip stops looking temporary.
        this.stats.skipped += 1;
        this.noteSkip(task, budget);
        continue;
      }
      this.skips.delete(task.id);
      this.queue.splice(this.queue.indexOf(task), 1);
      try {
        const result = await task.run();
        this.budget.consumeTokens(result.actualCalls);
        ran += 1;
        this.stats.ran += 1;
        this.lastRanAt = Date.now();
        if (result.actualCalls === 0) this.stats.yielded += 1;
        if (result.next) this.enqueue(result.next);
      } catch (err) {
        // Without this the whole runner dies on one bad task: runOnce()
        // rejects, run()'s loop unwinds, and every ship in the tenant stops
        // for good behind a single log line. A task is allowed to fail; the
        // scheduler is not allowed to fail with it.
        this.stats.failed += 1;
        this.log(`scheduler: task ${task.id} threw — ${err instanceof Error ? err.message : String(err)}`);
        // Re-enqueue with a small backoff so a persistently failing task
        // cannot spin the runner, and cannot silently vanish either.
        this.enqueue({ ...task, earliestRunAt: Date.now() + 5_000 });
      }
    }
    this.heartbeat(ready.length);
    return ran;
  }

  /**
   * Say something the first time a skip looks permanent rather than momentary.
   *
   * Two shapes matter. A task whose `estimatedCalls` exceeds the burst can
   * *never* be admitted — the constructor's comment has always warned about
   * this, and nothing ever checked it at runtime. And a task skipped pass
   * after pass is starving even if it is theoretically admittable. Both look
   * identical from outside: a fleet that does nothing and reports nothing.
   */
  private noteSkip(task: Task, budget: number): void {
    if (task.estimatedCalls > this.burst && !this.starved.has(task.id)) {
      this.starved.add(task.id);
      this.log(
        `scheduler: task ${task.id} can NEVER run — estimatedCalls ${task.estimatedCalls} exceeds burst ${this.burst}`,
      );
      return;
    }
    const n = (this.skips.get(task.id) ?? 0) + 1;
    this.skips.set(task.id, n);
    // ~100ms a pass, so 100 passes is roughly ten seconds of starvation.
    if (n === 100) {
      this.log(
        `scheduler: task ${task.id} starved for ${n} passes — needs ${task.estimatedCalls} calls, ${budget.toFixed(2)} available`,
      );
    }
  }

  /** Periodic proof of life, and of work. Silence here now means the process is gone, not that the fleet is idle. */
  private heartbeat(readyCount: number): void {
    const now = Date.now();
    if (now - this.lastHeartbeat < this.heartbeatMs) return;
    this.lastHeartbeat = now;
    const idleFor = Math.round((now - this.lastRanAt) / 1000);
    const s = this.stats;
    // When the queue is full but nothing is ready, the only useful question is
    // *when* those tasks think they are due — counts alone cannot distinguish
    // "parked for thirty seconds" from "parked until next week", and a task
    // rescheduled on a bad resume time looks exactly like a healthy idle one.
    // Name the soonest few, with how far out they are.
    const due = this.queue.length > 0 && readyCount === 0
      ? " · next due: " + [...this.queue]
          .sort((a, b) => a.earliestRunAt - b.earliestRunAt)
          .slice(0, 3)
          .map((t) => `${t.id}@+${Math.round((t.earliestRunAt - now) / 1000)}s`)
          .join(" ")
      : "";
    // PAUSED belongs in the first field, not deduced later. A halted fleet and
    // a broken one produce identical heartbeats otherwise: tokens full,
    // nothing skipped, nothing failing, tasks overdue and none of them ready,
    // because runOnce() admits only priority 0 while paused. That ambiguity
    // cost an afternoon — the fleet was halted the entire time and every
    // instrument, including this one, reported a healthy runner with nothing
    // to do.
    const halted = this.isPaused() ? "PAUSED " : "";
    this.log(
      `scheduler: ${halted}queue=${this.queue.length} ready=${readyCount} tokens=${this.budget.availableTokens().toFixed(2)} ` +
      `· ran=${s.ran} skipped=${s.skipped} failed=${s.failed} no-op=${s.yielded}` +
      (s.ran === 0 ? ` · NOTHING HAS RUN in ${idleFor}s` : ` · last ran ${idleFor}s ago`) + due,
    );
    this.stats = { ran: 0, skipped: 0, failed: 0, yielded: 0 };
  }

  /** Current counters, for a caller that wants them in its own diagnostics. */
  stats_(): { queue: number; ranSinceHeartbeat: number; idleSeconds: number } {
    return { queue: this.queue.length, ranSinceHeartbeat: this.stats.ran, idleSeconds: Math.round((Date.now() - this.lastRanAt) / 1000) };
  }

  /** The coordinator-style loop — same polling shape as FleetManager.run(), until stop() is called or maxTicks is reached. */
  async run(maxTicks = 1_000_000, pollIntervalMs = 100): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      await this.runOnce();
      await sleep(pollIntervalMs);
    }
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }
}
