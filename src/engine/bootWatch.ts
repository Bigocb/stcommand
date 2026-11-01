// What the fleet does in the minutes after a restart. Pure: the caller passes the clock and the facts.
//
// Why: every redeploy is followed by about ten minutes in which almost nothing is bought or sold while jumps roughly
// double (docs: CHANGELOG 2026-10-31/11-01). The cause is not known. This records, for a window after boot, what each
// trader was holding as a saved trip, what the dispatcher gave it on each cycle, and what it then did, so the next
// restart explains itself: ships stalling, being re-routed, or repeating moves.

/** "good|buyAt>sellAt" for an assignment, or null when there is none. */
export function assignmentKey(a: { good?: string; buyAt?: string; sellAt?: string } | undefined): string | null {
  if (!a || !a.good) return null;
  return `${a.good}|${a.buyAt ?? ""}>${a.sellAt ?? ""}`;
}

export interface BootRow {
  ship: string;
  /** "good|buyAt>sellAt" of the dispatcher's assignment for the ship, or null when it has none. */
  key: string | null;
  /** The ship has cargo aboard. */
  loaded: boolean;
}

export interface BootChange {
  ship: string;
  /** Seconds since boot. */
  atSec: number;
  change: "changed" | "dropped" | "new";
  loaded: boolean;
  before: string | null;
  after: string | null;
  /** Which observation this was seen on (0 is the first dispatcher cycle after boot). */
  cycle: number;
}

export interface BootSummary {
  bootAt: string;
  windowMin: number;
  elapsedMin: number;
  active: boolean;
  /** Saved trips found at boot. */
  restoredTrips: number;
  cycles: number;
  /** Seconds since boot of the first cycles. */
  cycleAtSec: number[];
  firstCycle?: { traders: number; withRoute: number; kept: number; changed: number; dropped: number; fresh: number; loadedAndChanged: number };
  /** Ships whose assignment changed on each later cycle (churn), loaded ones counted apart. */
  churn: { cycle: number; changed: number; loadedChanged: number }[];
  actionsByKind: Record<string, number>;
  /** Buys, sells and jumps per minute since boot. */
  perMinute: { minute: number; buy: number; sell: number; jump: number; other: number }[];
  /** Observed traders that bought or sold at least once in the window, and the ones that did not. */
  tradedInWindow: number;
  neverTraded: number;
  /** Seconds from boot to each ship's first buy or sell: median and slowest. */
  firstTradeSec: { median: number | null; slowest: number | null };
  changes: BootChange[];
  note: string;
}

const MAX_CHANGES = 80;

function classify(kind: string): "buy" | "sell" | "jump" | "other" {
  const k = kind.toLowerCase();
  if (k.includes("buy") || k.includes("purchase")) return "buy";
  if (k.includes("sell") || k.includes("sale")) return "sell";
  if (k.includes("jump")) return "jump";
  return "other";
}

export class BootWatch {
  private restored = new Map<string, string | null>();
  private restoredSet = false;
  private prev = new Map<string, string | null>();
  private readonly cycleAt: number[] = [];
  private firstCycle: BootSummary["firstCycle"];
  private readonly churn: BootSummary["churn"] = [];
  private readonly changes: BootChange[] = [];
  private readonly kinds: Record<string, number> = {};
  private readonly minutes = new Map<number, { buy: number; sell: number; jump: number; other: number }>();
  private readonly firstTrade = new Map<string, number>();
  private observed = new Set<string>();
  private persisted = false;

  constructor(private readonly bootMs: number, private readonly windowMs = 12 * 60_000) {}

  active(nowMs: number): boolean {
    return nowMs - this.bootMs <= this.windowMs;
  }

  /** True once the window is over and the summary has not been saved yet. */
  due(nowMs: number): boolean {
    return !this.persisted && !this.active(nowMs) && this.cycleAt.length > 0;
  }

  markPersisted(): void {
    this.persisted = true;
  }

  /** The trips saved from before the restart, as found right after they were loaded. Only the first call counts. */
  noteRestored(rows: { ship: string; key: string | null }[]): void {
    if (this.restoredSet) return;
    this.restoredSet = true;
    for (const r of rows) this.restored.set(r.ship, r.key);
  }

  /** One dispatcher cycle's view of every trader. Cycle 0 is compared with the restored trips, later ones with the last cycle. */
  observe(nowMs: number, rows: BootRow[]): void {
    if (!this.active(nowMs)) return;
    const cycle = this.cycleAt.length;
    const atSec = Math.round((nowMs - this.bootMs) / 1000);
    this.cycleAt.push(atSec);
    const base = cycle === 0 ? this.restored : this.prev;
    let kept = 0, changed = 0, dropped = 0, fresh = 0, loadedChanged = 0, withRoute = 0;
    for (const r of rows) {
      this.observed.add(r.ship);
      if (r.key !== null) withRoute += 1;
      const before = base.has(r.ship) ? (base.get(r.ship) ?? null) : null;
      let kind: BootChange["change"] | undefined;
      if (before !== null && r.key === before) kept += 1;
      else if (before !== null && r.key === null) kind = "dropped";
      else if (before !== null && r.key !== null) kind = "changed";
      else if (before === null && r.key !== null) kind = "new";
      if (kind === "dropped") dropped += 1;
      else if (kind === "changed") changed += 1;
      else if (kind === "new") fresh += 1;
      if (kind) {
        if (kind !== "new" && r.loaded) loadedChanged += 1;
        if (this.changes.length < MAX_CHANGES && (cycle === 0 || kind !== "new")) {
          this.changes.push({ ship: r.ship, atSec, change: kind, loaded: r.loaded, before, after: r.key, cycle });
        }
      }
    }
    if (cycle === 0) this.firstCycle = { traders: rows.length, withRoute, kept, changed, dropped, fresh, loadedAndChanged: loadedChanged };
    else this.churn.push({ cycle, changed: changed + dropped, loadedChanged });
    this.prev = new Map(rows.map((r) => [r.ship, r.key]));
  }

  /** One thing a ship did (the activity feed's kind and text). */
  noteAction(nowMs: number, ship: string, kind: string): void {
    if (!this.active(nowMs)) return;
    this.kinds[kind] = (this.kinds[kind] ?? 0) + 1;
    const c = classify(kind);
    const m = Math.floor((nowMs - this.bootMs) / 60_000);
    const row = this.minutes.get(m) ?? { buy: 0, sell: 0, jump: 0, other: 0 };
    row[c] += 1;
    this.minutes.set(m, row);
    if ((c === "buy" || c === "sell") && !this.firstTrade.has(ship)) this.firstTrade.set(ship, Math.round((nowMs - this.bootMs) / 1000));
  }

  summary(nowMs: number): BootSummary {
    const secs = [...this.firstTrade.values()].sort((a, b) => a - b);
    const traded = [...this.observed].filter((s) => this.firstTrade.has(s)).length;
    return {
      bootAt: new Date(this.bootMs).toISOString(),
      windowMin: Math.round(this.windowMs / 60_000),
      elapsedMin: Math.round(((nowMs - this.bootMs) / 60_000) * 10) / 10,
      active: this.active(nowMs),
      restoredTrips: [...this.restored.values()].filter((v) => v !== null).length,
      cycles: this.cycleAt.length,
      cycleAtSec: this.cycleAt.slice(0, 8),
      ...(this.firstCycle ? { firstCycle: this.firstCycle } : {}),
      churn: this.churn,
      actionsByKind: this.kinds,
      perMinute: [...this.minutes.entries()].sort((a, b) => a[0] - b[0]).map(([minute, v]) => ({ minute, ...v })),
      tradedInWindow: traded,
      neverTraded: Math.max(0, this.observed.size - traded),
      firstTradeSec: { median: secs.length ? secs[Math.floor(secs.length / 2)]! : null, slowest: secs.length ? secs[secs.length - 1]! : null },
      changes: this.changes,
      note: "cycle 0 is the first dispatcher cycle after boot, compared with the trips saved before the restart: kept = same route, changed = a different route, dropped = it had a saved trip and now has none, fresh = no saved trip and now has one. loadedAndChanged counts ships with cargo aboard whose route changed. Later cycles compare with the cycle before (churn).",
    };
  }
}
