/**
 * Connections held back for traders (issue #88, database fix 4).
 *
 * Every task borrows its database connections from one pool. On 2026-11-27, with the trade lane at 4 workers, keepers
 * (about 600 market reads a minute), tour ships and the HTTP endpoints kept the pool busy, and a trade step waited 1.9 s
 * for a connection (54% of the step). Here work that does not run in the "trade" database lane may hold at most
 * `limit` connections at once (the pool size less a reserve), so the reserve is always free for traders; trade work goes
 * straight to the pool. The pool's own limit still caps the total.
 *
 * The lane rides on AsyncLocalStorage, so everything a trade task awaits (store calls, ledger writes) is counted as
 * trade work without passing anything down. Pure apart from that: no pg, no clock.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const laneContext = new AsyncLocalStorage<string>();

/** Run `fn` with every database checkout inside it counted in `lane` ("trade" skips the gate). */
export function runInDbLane<T>(lane: string, fn: () => Promise<T>): Promise<T> {
  return laneContext.run(lane, fn);
}

export function currentDbLane(): string | undefined {
  return laneContext.getStore();
}

/** A FIFO counting semaphore whose limit is read on every acquire and release, so it can change live. */
export class ConnectionGate {
  private held = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  get inUse(): number {
    return this.held;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves with a release function once a slot is free. Call the release exactly once. */
  async acquire(): Promise<() => void> {
    if (this.held < Math.max(1, this.limit()) && this.waiters.length === 0) {
      this.held++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      // The releaser handed its slot straight to this waiter (held was not decremented), so nothing to add here.
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.waiters.length > 0 && this.held <= Math.max(1, this.limit()) ? this.waiters.shift() : undefined;
    if (next) {
      next(); // hand the slot over; held stays the same
      return;
    }
    this.held--;
    // The limit may have grown since: wake as many waiters as now fit.
    while (this.waiters.length > 0 && this.held < Math.max(1, this.limit())) {
      this.held++;
      this.waiters.shift()!();
    }
  }
}

/** The general (non-trade) limit for a pool of `poolMax`: the pool less the reserve, never under 1. */
export function generalLimit(poolMax: number, reserve: number): number {
  const r = Math.max(0, Math.floor(reserve));
  return Math.max(1, Math.floor(poolMax) - r);
}

/** Connections kept for traders: DB_TRADE_RESERVE, default 10; 0 turns the gate off (the behaviour before). */
export function tradeReserve(): number {
  const raw = process.env.DB_TRADE_RESERVE;
  const n = raw === undefined || raw === "" ? 10 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}

const gates = new WeakMap<object, ConnectionGate>();

/**
 * Take a slot for one checkout from `pool` (sized `poolMax`). Trade-lane work and a reserve of 0 skip the gate and get a
 * no-op release. Await it before pool.connect() and call the release after client.release().
 */
export async function acquireConnectionSlot(pool: object, poolMax: number): Promise<() => void> {
  const reserve = tradeReserve();
  if (reserve === 0 || currentDbLane() === "trade") return () => {};
  let gate = gates.get(pool);
  if (!gate) {
    gate = new ConnectionGate(() => generalLimit(poolMax, tradeReserve()));
    gates.set(pool, gate);
  }
  return gate.acquire();
}

/** For ops: the gate's current use on `pool`, if one exists. */
export function connectionGateStats(pool: object): { inUse: number; waiting: number } | undefined {
  const g = gates.get(pool);
  return g ? { inUse: g.inUse, waiting: g.waiting } : undefined;
}
