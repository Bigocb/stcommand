/**
 * Timers and cool-offs that must outlive a restart.
 *
 * The keeper queue's wait for a ship at a yard, the cool-off after a request is let go, and the remote surveyor's retry times all
 * lived in plain in-memory maps, so every deploy (five on 2026-10-29) started them again: a 30-minute wait that is restarted every
 * 20 minutes never ends. This keeps them as one JSON document (a fleet flag) that is read once and written whenever something
 * changes. Pure apart from the two callbacks, which the caller wires to the store.
 */
export interface TimerStore {
  read: () => Promise<string | undefined>;
  write: (json: string) => Promise<void>;
}

export type TimerBook = Record<"yardWait" | "queueCooldown" | "surveyRetry" | "topUp", Map<string, number>>;

export class PersistedTimers {
  readonly book: TimerBook = { yardWait: new Map(), queueCooldown: new Map(), surveyRetry: new Map(), topUp: new Map() };
  private loaded = false;
  constructor(private readonly io: TimerStore) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.io.read();
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object") return;
      for (const name of Object.keys(this.book) as (keyof TimerBook)[]) {
        const section = (parsed as Record<string, unknown>)[name];
        if (section && typeof section === "object") {
          for (const [k, v] of Object.entries(section as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) this.book[name].set(k, v);
        }
      }
    } catch {
      /* an unreadable document means no timers are known: they start again, as before */
    }
  }

  /** Drop what has run out (`now`), then write. Entries that mean "when this wait started" are not expired by time, only by the caller. */
  async save(now: number): Promise<void> {
    for (const name of ["queueCooldown", "surveyRetry"] as const) for (const [k, until] of this.book[name]) if (until <= now) this.book[name].delete(k);
    const doc = Object.fromEntries((Object.keys(this.book) as (keyof TimerBook)[]).map((n) => [n, Object.fromEntries(this.book[n])]));
    try { await this.io.write(JSON.stringify(doc)); } catch { /* the in-memory copy still works for this run */ }
  }
}
