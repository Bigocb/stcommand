/**
 * Greenfield Phase 5: the unified scheduler skeleton — Pillar 3 of the
 * design doc, and the highest-risk phase in the whole sequence (see
 * README's Greenfield section). This file is the queue/runner/budget
 * mechanics only: a priority task queue, a per-tenant call budget, and a
 * runner loop that drains ready tasks within that budget, highest priority
 * first, pausing everything but rescue (priority 0) while the fleet is
 * halted.
 *
 * What this file deliberately does NOT do: replace any agent's existing
 * `runLoop()`. `fleet.run()` still boots the old per-agent blocking loops
 * exactly as before — nothing here is wired as their replacement. Phase 6/7
 * add `nextTask()` producers to TraderAgent/ShipAgent/ScoutAgent/
 * SiphonerAgent that this scheduler *could* drive, each one built and
 * tested standalone, but `fleet.run()` doesn't call `Scheduler.enqueue()`
 * with any of them — see those files' own comments for why. A `Scheduler`
 * can be instantiated and run per tenant (TenantRegistry does, harmlessly,
 * with an empty queue) without changing a single thing about how the fleet
 * actually operates today.
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

  constructor(opts: { ratePerSec?: number; burst?: number; isPaused?: () => boolean } = {}) {
    // Matches Client's own RateLimiter (see client.ts's comment) — admitting
    // tasks faster than the transport layer can actually sustain just means
    // more of them arrive at the real 429 ceiling instead of waiting here.
    this.budget = new SchedulerBudget(opts.ratePerSec ?? 1.5, opts.burst ?? 30);
    this.isPaused = opts.isPaused ?? (() => false);
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
      let budget = this.budget.availableTokens();
      if (task.estimatedCalls > budget) continue; // save the remaining budget for a higher-priority task later in this pass
      this.queue.splice(this.queue.indexOf(task), 1);
      const result = await task.run();
      this.budget.consumeTokens(result.actualCalls);
      ran += 1;
      if (result.next) this.enqueue(result.next);
    }
    return ran;
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
