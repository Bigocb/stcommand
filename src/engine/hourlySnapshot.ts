/**
 * Hourly fleet snapshot: what the ledger does not keep, written once an hour so a later week can be set against this one
 * (operator request, 2026-10-30: keepers, live systems and API load over the week). Stored as an `hourly_snapshot` action event
 * (action_events keeps every week, keyed by universe_key), so there is no new table and a reset wipes nothing.
 *
 * Pure: the fleet gathers the facts and decides when; this builds the record and, for the compare screen, lines the readings up
 * with the ledger's hours.
 */
import type { ActionEventRecord } from "../db/store.js";

export const SNAPSHOT_KIND = "hourly_snapshot";

export interface SnapshotFacts {
  /** Keepers polling their market. */
  keepers: number;
  /** Keepers parked (staged systems, idle systems, triage). */
  keepersParked: number;
  liveSystems: number;
  stagedSystems: number;
  scoutedSystems: number;
  /** Keepers' API calls a minute, as the keeper review computes it. */
  keeperCallsPerMin: number;
  ships: number;
  traders: number;
  wallet: number;
}

/** Hour of the epoch a moment falls in, so a restart inside an hour does not write a second reading. */
export function hourOf(ms: number): number {
  return Math.floor(ms / 3_600_000);
}

export function hourlySnapshotEvent(f: SnapshotFacts, atIso: string): ActionEventRecord {
  return { at: atIso, kind: SNAPSHOT_KIND, actor: "engine", subject: "fleet", observed: { ...f, keeperCallsPerMin: Math.round(f.keeperCallsPerMin * 10) / 10 } };
}

/** One compare-screen point per hour. A hour with no reading is null so a chart leaves a gap, not a zero. */
export interface FleetPoint {
  hour: number;
  keepers: number | null;
  live: number | null;
  calls: number | null;
}

/** Readings (any order) set on the ledger's hour axis: hour 0 is `startAtIso`. The last reading in an hour stands. */
export function fleetPoints(rows: readonly { at: string; observed?: Record<string, unknown> }[], startAtIso: string | null, upToHour: number): FleetPoint[] {
  const out: FleetPoint[] = Array.from({ length: upToHour + 1 }, (_, hour) => ({ hour, keepers: null, live: null, calls: null }));
  const start = startAtIso ? Date.parse(startAtIso) : NaN;
  if (!Number.isFinite(start)) return out;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const hour = Math.floor((Date.parse(r.at) - start) / 3_600_000);
    if (hour < 0 || hour > upToHour) continue;
    const o = r.observed ?? {};
    out[hour] = { hour, keepers: num(o.keepers), live: num(o.liveSystems), calls: num(o.keeperCallsPerMin) };
  }
  return out;
}
