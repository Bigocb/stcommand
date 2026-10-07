/**
 * Hold this process's fleets until the instance it replaces has stopped.
 *
 * A Render deploy starts the new instance, waits for its health check, moves traffic, and only then sends the old one
 * SIGTERM. Fleets used to start at boot, so for that gap two processes flew the same ships. Confirmed live
 * 2026-10-07: two pushes 50 s apart gave THEO two drivers for ~30 s and then ~60 s, which showed up as doubled
 * refuels, a sell of 30 units from a ship holding 20, and "ship is in transit" errors. The web server still starts
 * at once (the health check must pass for the old instance ever to be stopped); only tenant boot waits.
 */
export interface PredecessorGateOptions {
  /** Instances other than this one that checked in within the last `withinSec` seconds. */
  others: (withinSec: number) => Promise<{ instanceId: string; startedAt: string }[]>;
  /** When this process started; only instances that started before it are waited for. */
  bootedAt: Date;
  log: (msg: string) => void;
  /** Heartbeats are written every 10 s, so 15 s of silence means the instance has gone. */
  aliveWithinSec?: number;
  pollMs?: number;
  /** Start anyway after this long: a stuck heartbeat row must not keep the fleets grounded. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForPredecessor(opts: PredecessorGateOptions): Promise<void> {
  const aliveWithinSec = opts.aliveWithinSec ?? 15;
  const pollMs = opts.pollMs ?? 3_000;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  let announced = false;
  for (;;) {
    let older: string[];
    try {
      older = (await opts.others(aliveWithinSec))
        .filter((i) => Date.parse(i.startedAt) < opts.bootedAt.getTime())
        .map((i) => i.instanceId);
    } catch (err) {
      opts.log(`instance gate: could not read heartbeats (${err instanceof Error ? err.message : String(err)}) — starting fleets`);
      return;
    }
    const waited = now() - start;
    if (older.length === 0) {
      if (announced) opts.log(`instance gate: previous instance gone after ${Math.round(waited / 1000)}s — starting fleets`);
      return;
    }
    if (waited >= maxWaitMs) {
      opts.log(`instance gate: ${older.join(", ")} still checking in after ${Math.round(waited / 1000)}s — starting fleets anyway`);
      return;
    }
    if (!announced) {
      opts.log(`instance gate: waiting for ${older.join(", ")} to stop before starting fleets`);
      announced = true;
    }
    await sleep(pollMs);
  }
}
