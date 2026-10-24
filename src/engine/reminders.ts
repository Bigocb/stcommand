/**
 * Reminders the engine sets for itself: "look at this again at <time>", kept across a restart.
 *
 * The first user is keeper triage (keeperTriage.ts): park a keeper on a dead or crashed market and come back in an hour or
 * two to see whether it has recovered. Anything that needs a later second look can use the same list.
 *
 * Pure: no I/O, no clock (the caller passes `now`). One reminder per (kind, subject): adding another replaces the first, so a
 * check that runs every few minutes cannot pile them up. The list is small and is saved whole as JSON by the caller.
 */

export interface Reminder {
  id: string;
  /** What kind of follow-up, for example "keeper_recheck". */
  kind: string;
  /** What it is about, for example a ship symbol. */
  subject: string;
  dueAt: number;
  createdAt: number;
  /** One line for the log and the operator. */
  note: string;
  /** Whatever the owner of this kind needs back when it fires (counts, the market). Plain JSON only. */
  data?: Record<string, unknown>;
}

export const MAX_REMINDERS = 500;
/** A reminder nobody picked up for this long after it was due is dropped on restore. */
export const STALE_AFTER_MS = 7 * 24 * 3_600_000;

export class Reminders {
  private items = new Map<string, Reminder>();
  private seq = 0;

  private static key(kind: string, subject: string): string {
    return `${kind}\u0000${subject}`;
  }

  /** Set (or replace) the reminder for this kind and subject. */
  add(r: { kind: string; subject: string; dueAt: number; note: string; data?: Record<string, unknown> }, now: number): Reminder {
    const reminder: Reminder = { id: `r${now.toString(36)}${(this.seq++).toString(36)}`, createdAt: now, ...r };
    this.items.set(Reminders.key(r.kind, r.subject), reminder);
    // Never grow without bound: past the cap the one due furthest in the future goes.
    if (this.items.size > MAX_REMINDERS) {
      const last = [...this.items.values()].sort((a, b) => b.dueAt - a.dueAt)[0]!;
      this.items.delete(Reminders.key(last.kind, last.subject));
    }
    return reminder;
  }

  get(kind: string, subject: string): Reminder | undefined {
    return this.items.get(Reminders.key(kind, subject));
  }

  has(kind: string, subject: string): boolean {
    return this.items.has(Reminders.key(kind, subject));
  }

  /** Does this subject have a reminder of any kind in `kinds`? */
  hasAny(subject: string, kinds: readonly string[]): boolean {
    return kinds.some((k) => this.has(k, subject));
  }

  cancel(kind: string, subject: string): boolean {
    return this.items.delete(Reminders.key(kind, subject));
  }

  /** Reminders whose time has come, soonest first. They stay in the list until cancelled or replaced. */
  due(now: number, kind?: string): Reminder[] {
    return [...this.items.values()].filter((r) => r.dueAt <= now && (!kind || r.kind === kind)).sort((a, b) => a.dueAt - b.dueAt);
  }

  list(): Reminder[] {
    return [...this.items.values()].sort((a, b) => a.dueAt - b.dueAt);
  }

  get size(): number {
    return this.items.size;
  }

  toJson(): string {
    return JSON.stringify(this.list());
  }

  /** Load a saved list, skipping anything malformed or long overdue. Returns how many were kept. */
  restore(json: string, now: number): number {
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
      const x = r as Partial<Reminder>;
      if (typeof x.kind !== "string" || typeof x.subject !== "string" || typeof x.dueAt !== "number" || !Number.isFinite(x.dueAt)) continue;
      if (now - x.dueAt > STALE_AFTER_MS) continue;
      this.items.set(Reminders.key(x.kind, x.subject), {
        id: typeof x.id === "string" ? x.id : `r${now.toString(36)}${(this.seq++).toString(36)}`,
        kind: x.kind,
        subject: x.subject,
        dueAt: x.dueAt,
        createdAt: typeof x.createdAt === "number" ? x.createdAt : now,
        note: typeof x.note === "string" ? x.note : "",
        ...(x.data && typeof x.data === "object" ? { data: x.data as Record<string, unknown> } : {}),
      });
      kept++;
    }
    return kept;
  }
}
