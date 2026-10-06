/**
 * Phase 1 of the batched ship reads (docs/TODO.md, "Batch ship reads"): measure, change nothing.
 *
 * Every agent step starts by reading its own ship (`GET /my/ships/:id`), the largest single use of the game-API
 * budget, and it grows with every ship added. `GET /my/ships` returns complete ships twenty at a time, so one sweep
 * every few seconds could stand in for most of those reads — if a sweep copy is as good as a fresh read. This board
 * answers that before anything trusts it: a background sweep records every ship, and each single-ship read the fleet
 * makes anyway is compared with the latest sweep copy, as Phase 2 would have used it.
 *
 * A comparison only counts as "eligible" when Phase 2 would really have served the sweep copy: the copy is recent,
 * and the ship has not acted since it was taken (an action's own response is newer than any sweep). Before comparing,
 * the copy is advanced the way Phase 2 would advance it: a transit whose arrival time has passed reads as arrived, and
 * a cooldown whose expiration has passed reads as clear.
 */

/** Hooked into the API client: every single-ship read and every ship action. */
export interface ShipObserver {
  onShipRead(symbol: string, ship: unknown): void;
  onShipAction(symbol: string): void;
}

interface Fingerprint {
  status?: string;
  waypoint?: string;
  destination?: string;
  arrival?: string;
  fuel?: number;
  cargoUnits?: number;
  cooldownExpiration?: string;
}

/** The fields a step-start read is actually used for. */
const FIELDS = ["status", "waypoint", "fuel", "cargoUnits", "cooldown"] as const;
type Field = (typeof FIELDS)[number];

export interface SnapshotSummary {
  /** Single-ship reads seen. */
  reads: number;
  /** Reads Phase 2 would have answered from the sweep copy. */
  eligible: number;
  /** Of those, how many matched the fresh read on every field. */
  matched: number;
  /** Mismatches per field, among eligible reads. */
  mismatches: Record<Field, number>;
  /** The ship had acted since the copy was taken, so Phase 2 would not have used it. */
  actedSince: number;
  /** No sweep copy recent enough. */
  noRecentCopy: number;
}

function fingerprint(ship: unknown): Fingerprint {
  const s = ship as {
    nav?: { status?: string; waypointSymbol?: string; route?: { arrival?: string; destination?: { symbol?: string } } };
    fuel?: { current?: number };
    cargo?: { units?: number };
    cooldown?: { remainingSeconds?: number; expiration?: string };
  } | undefined;
  return {
    status: s?.nav?.status,
    waypoint: s?.nav?.waypointSymbol,
    destination: s?.nav?.route?.destination?.symbol,
    arrival: s?.nav?.route?.arrival,
    fuel: s?.fuel?.current,
    cargoUnits: s?.cargo?.units,
    cooldownExpiration: s?.cooldown && (s.cooldown.remainingSeconds ?? 0) > 0 ? s.cooldown.expiration : undefined,
  };
}

/** A copy as Phase 2 would present it at `now`: a finished transit has arrived, an expired cooldown is clear. */
function advance(f: Fingerprint, now: number): Fingerprint {
  const out = { ...f };
  if (f.status === "IN_TRANSIT" && f.arrival && Date.parse(f.arrival) <= now) {
    out.status = "IN_ORBIT";
    out.waypoint = f.destination ?? f.waypoint;
  }
  if (f.cooldownExpiration && Date.parse(f.cooldownExpiration) <= now) out.cooldownExpiration = undefined;
  return out;
}

function sameCooldown(a?: string, b?: string): boolean {
  if (!a || !b) return a === b;
  return Math.abs(Date.parse(a) - Date.parse(b)) < 2_000;
}

function emptySummary(): SnapshotSummary {
  return { reads: 0, eligible: 0, matched: 0, mismatches: { status: 0, waypoint: 0, fuel: 0, cargoUnits: 0, cooldown: 0 }, actedSince: 0, noRecentCopy: 0 };
}

export class ShipSnapshotBoard implements ShipObserver {
  private readonly copies = new Map<string, { at: number; f: Fingerprint }>();
  private readonly lastAction = new Map<string, number>();
  private stats = emptySummary();

  constructor(
    /** How old a sweep copy may be and still stand in for a read — Phase 2's own threshold. */
    private readonly maxAgeMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one sweep. `at` is when its response came back. */
  recordSweep(ships: readonly unknown[], at: number = this.now()): void {
    for (const ship of ships) {
      const symbol = (ship as { symbol?: string }).symbol;
      if (symbol) this.copies.set(symbol, { at, f: fingerprint(ship) });
    }
  }

  onShipAction(symbol: string): void {
    this.lastAction.set(symbol, this.now());
  }

  onShipRead(symbol: string, ship: unknown): void {
    const now = this.now();
    this.stats.reads += 1;
    const copy = this.copies.get(symbol);
    if (!copy || now - copy.at > this.maxAgeMs) {
      this.stats.noRecentCopy += 1;
      return;
    }
    if ((this.lastAction.get(symbol) ?? 0) >= copy.at) {
      this.stats.actedSince += 1;
      return;
    }
    this.stats.eligible += 1;
    const was = advance(copy.f, now);
    const is = fingerprint(ship);
    let ok = true;
    const miss = (field: Field) => {
      ok = false;
      this.stats.mismatches[field] += 1;
    };
    if (was.status !== is.status) miss("status");
    if (was.waypoint !== is.waypoint) miss("waypoint");
    if (was.fuel !== is.fuel) miss("fuel");
    if (was.cargoUnits !== is.cargoUnits) miss("cargoUnits");
    if (!sameCooldown(was.cooldownExpiration, is.cooldownExpiration)) miss("cooldown");
    if (ok) this.stats.matched += 1;
  }

  /** The counts since the last call, then start over. */
  takeSummary(): SnapshotSummary {
    const out = this.stats;
    this.stats = emptySummary();
    return out;
  }
}

/** One log line for a summary. */
export function describeSnapshotSummary(s: SnapshotSummary): string {
  const pct = s.eligible ? Math.round((s.matched / s.eligible) * 100) : 0;
  const misses = FIELDS.filter((f) => s.mismatches[f] > 0).map((f) => `${f} ${s.mismatches[f]}`).join(", ") || "none";
  return `ship sweep: ${s.reads} single reads · ${s.eligible} could have used the sweep, ${s.matched} matched (${pct}%) · mismatches: ${misses} · ${s.actedSince} acted since the sweep · ${s.noRecentCopy} no recent copy`;
}
