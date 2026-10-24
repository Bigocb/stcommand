/**
 * The queue of fresh systems: scouted, staged, live (docs/fresh-system-expansion-plan.md, "Queued systems and the release gate").
 *
 * A system an explorer has found worth covering is not opened at once. It waits behind a gate, so its premium (about 1.7x the mature
 * profit per unit for roughly 8 hours after coverage, measured 2026-10-24) is not spent by whichever hulls reach it first, and is opened
 * when the fleet needs a fresh one:
 *
 *   scouted  toured and accepted; nothing bought; routes through it are not offered to traders.
 *   staged   keepers bought, sent and parked on their markets (a parked keeper polls nothing, so waiting costs no API budget); gate shut.
 *   live     the gate is open and the keepers are unparked. The freshness clock starts here.
 *
 * `held` pins a system that is not live: the engine will not stage or release it, only the operator can.
 *
 * Pure: no I/O, no clock (the caller passes `now`). Saved whole as JSON by the caller and restored at boot. One entry per system.
 */

export type SystemState = "scouted" | "staged" | "live";

export interface QueuedSystem {
  system: string;
  state: SystemState;
  /** The markets to keep covered: the top few by keeper score, best first. */
  markets: string[];
  addedAt: number;
  stagedAt?: number;
  releasedAt?: number;
  /** Operator pin: the engine leaves this system alone until it is cleared. */
  held: boolean;
  /** Why it is in this state, for the operator. */
  note?: string;
}

export const MAX_QUEUED = 200;

export class SystemQueue {
  private items = new Map<string, QueuedSystem>();

  /** Add a system as scouted. A system already in the queue keeps its state; its market list is refreshed while it has not gone live. */
  scout(system: string, markets: readonly string[], now: number, note?: string): QueuedSystem {
    const have = this.items.get(system);
    if (have) {
      if (have.state !== "live" && markets.length) have.markets = [...markets];
      return have;
    }
    const q: QueuedSystem = { system, state: "scouted", markets: [...markets], addedAt: now, held: false, ...(note ? { note } : {}) };
    this.items.set(system, q);
    if (this.items.size > MAX_QUEUED) {
      const oldest = [...this.items.values()].filter((x) => x.state === "live").sort((a, b) => a.addedAt - b.addedAt)[0];
      if (oldest) this.items.delete(oldest.system);
    }
    return q;
  }

  /** scouted -> staged. Returns false when the system is unknown or already staged or live. */
  stage(system: string, now: number, note?: string): boolean {
    const q = this.items.get(system);
    if (!q || q.state !== "scouted") return false;
    q.state = "staged";
    q.stagedAt = now;
    if (note) q.note = note;
    return true;
  }

  /** staged (or scouted) -> live. A manual release also clears the hold. Returns false when unknown or already live. */
  release(system: string, now: number, note?: string): boolean {
    const q = this.items.get(system);
    if (!q || q.state === "live") return false;
    q.state = "live";
    q.releasedAt = now;
    q.held = false;
    if (note) q.note = note;
    return true;
  }

  /** Pin or unpin a system that is not live. Returns false when unknown or live (a live system has no gate to hold). */
  hold(system: string, held: boolean): boolean {
    const q = this.items.get(system);
    if (!q || q.state === "live") return false;
    q.held = held;
    return true;
  }

  forget(system: string): boolean {
    return this.items.delete(system);
  }

  get(system: string): QueuedSystem | undefined {
    return this.items.get(system);
  }

  list(): QueuedSystem[] {
    return [...this.items.values()].sort((a, b) => a.addedAt - b.addedAt || a.system.localeCompare(b.system));
  }

  /** Systems whose routes traders must not be offered: everything that is not live. */
  gated(): Set<string> {
    return new Set([...this.items.values()].filter((q) => q.state !== "live").map((q) => q.system));
  }

  get size(): number {
    return this.items.size;
  }

  toJson(): string {
    return JSON.stringify(this.list());
  }

  /** Load a saved queue, skipping anything malformed. Returns how many were kept. */
  restore(json: string): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed)) return 0;
    let kept = 0;
    for (const r of parsed) {
      if (!r || typeof r !== "object") continue;
      const x = r as Partial<QueuedSystem>;
      if (typeof x.system !== "string" || (x.state !== "scouted" && x.state !== "staged" && x.state !== "live") || typeof x.addedAt !== "number") continue;
      this.items.set(x.system, {
        system: x.system,
        state: x.state,
        markets: Array.isArray(x.markets) ? x.markets.filter((m): m is string => typeof m === "string") : [],
        addedAt: x.addedAt,
        held: x.held === true,
        ...(typeof x.stagedAt === "number" ? { stagedAt: x.stagedAt } : {}),
        ...(typeof x.releasedAt === "number" ? { releasedAt: x.releasedAt } : {}),
        ...(typeof x.note === "string" ? { note: x.note } : {}),
      });
      kept++;
    }
    return kept;
  }
}
