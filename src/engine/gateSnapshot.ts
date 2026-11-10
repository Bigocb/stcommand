/**
 * Gate-mission snapshots: where each material stood, every 15 minutes while a construction mission runs (operator request,
 * 2026-11-10: "look at the same hour last week and see what the status was"). Stored as a `gate_snapshot` action event
 * (action_events keeps every week, keyed by universe_key), so there is no new table and a reset wipes nothing, the same
 * way hourlySnapshot.ts does it for the fleet.
 *
 * What the ledger cannot say: how much of each material the site had received at a given time, the ask on the producer's
 * market against the ceiling, whether the mission was buying or yielding, and how many carriers it held. gate_progress_samples
 * (agent watch) keeps only the total, on change, from the public endpoint; this keeps the per-material picture with our own context.
 *
 * Pure: the fleet gathers the facts and decides when; this builds the record and lines two weeks up on elapsed hours since each
 * week's own start.
 */
import type { ActionEventRecord } from "../db/store.js";

export const GATE_SNAPSHOT_KIND = "gate_snapshot";
/** Minutes between readings while a mission is active. */
export const GATE_SNAPSHOT_MIN = 15;

export interface GateMaterialFacts {
  material: string;
  required: number;
  fulfilled: number;
  /** Cheapest ask known in the mission's system, or null when no market quotes it. */
  ask: number | null;
  /** The mission's price ceiling for this material, or null when only the percentage guard applies. */
  ceiling: number | null;
}

export interface GateCarrierFacts {
  ship: string;
  step: string;
  material?: string;
}

export interface GateSnapshotFacts {
  waypoint: string;
  status: "active" | "complete";
  paused: boolean;
  /** Yield mode's verdict ("run", "yield", "hold"), or null when the mode is off. */
  decision: string | null;
  reason: string | null;
  carriers: GateCarrierFacts[];
  wallet: number;
  materials: GateMaterialFacts[];
}

/** The reading slot a moment falls in, so a restart inside a slot does not write a second reading. */
export function slotOf(ms: number, minutes = GATE_SNAPSHOT_MIN): number {
  return Math.floor(ms / (minutes * 60_000));
}

export function gateSnapshotEvent(f: GateSnapshotFacts, atIso: string): ActionEventRecord {
  return {
    at: atIso,
    kind: GATE_SNAPSHOT_KIND,
    actor: "engine",
    subject: f.waypoint,
    observed: {
      status: f.status,
      paused: f.paused,
      decision: f.decision,
      reason: f.reason,
      carriers: f.carriers,
      wallet: f.wallet,
      materials: f.materials,
    },
  };
}

/** One reading, placed on a week's own clock: hour 0 is that week's start. */
export interface GateReading {
  at: string;
  elapsedH: number;
  status: string;
  paused: boolean;
  decision: string | null;
  reason: string | null;
  carriers: number;
  wallet: number | null;
  materials: GateMaterialFacts[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Parse stored events (any order) into readings for one waypoint, hours counted from `startAtIso`. Rows before the start are dropped. */
export function gateReadings(
  rows: readonly { at: string; subject?: string; observed?: Record<string, unknown> }[],
  startAtIso: string,
  waypoint?: string,
): GateReading[] {
  const start = Date.parse(startAtIso);
  if (!Number.isFinite(start)) return [];
  const out: GateReading[] = [];
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    if (waypoint && r.subject !== waypoint) continue;
    const elapsedH = (Date.parse(r.at) - start) / 3_600_000;
    if (!(elapsedH >= 0)) continue;
    const o = r.observed ?? {};
    const mats = Array.isArray(o.materials) ? o.materials : [];
    out.push({
      at: r.at,
      elapsedH: Math.round(elapsedH * 100) / 100,
      status: str(o.status) ?? "active",
      paused: o.paused === true,
      decision: str(o.decision),
      reason: str(o.reason),
      carriers: Array.isArray(o.carriers) ? o.carriers.length : 0,
      wallet: num(o.wallet),
      materials: mats.map((m: any) => ({
        material: String(m?.material ?? ""),
        required: num(m?.required) ?? 0,
        fulfilled: num(m?.fulfilled) ?? 0,
        ask: num(m?.ask),
        ceiling: num(m?.ceiling),
      })).filter((m: GateMaterialFacts) => m.material),
    });
  }
  return out;
}

/** The latest reading at or before `elapsedH`, or null when the week has none that early. */
export function readingAtOrBefore(readings: readonly GateReading[], elapsedH: number): GateReading | null {
  let found: GateReading | null = null;
  for (const r of readings) {
    if (r.elapsedH <= elapsedH) found = r;
    else break;
  }
  return found;
}

export interface GateMaterialDelta {
  material: string;
  required: number;
  thisFulfilled: number | null;
  otherFulfilled: number | null;
  /** thisFulfilled - otherFulfilled; positive means this week is further along. */
  ahead: number | null;
  thisAsk: number | null;
  otherAsk: number | null;
  thisCeiling: number | null;
  otherCeiling: number | null;
}

export interface GateComparison {
  atElapsedH: number;
  thisReadingAt: string | null;
  otherReadingAt: string | null;
  thisDecision: string | null;
  otherDecision: string | null;
  thisCarriers: number | null;
  otherCarriers: number | null;
  materials: GateMaterialDelta[];
  /** One row per elapsed hour from the first reading of either week to `atElapsedH`: units fulfilled per material, both weeks. */
  hourly: { hour: number; this: Record<string, number>; other: Record<string, number> }[];
  notes: string[];
}

const fulfilledMap = (r: GateReading | null): Record<string, number> => Object.fromEntries((r?.materials ?? []).map((m) => [m.material, m.fulfilled]));

/** Set this week against another at the same elapsed hour. Either side may have no reading that early; that is said, not guessed. */
export function compareGateWeeks(thisReadings: readonly GateReading[], otherReadings: readonly GateReading[], atElapsedH: number): GateComparison {
  const a = readingAtOrBefore(thisReadings, atElapsedH);
  const b = readingAtOrBefore(otherReadings, atElapsedH);
  const names = [...new Set([...(a?.materials ?? []), ...(b?.materials ?? [])].map((m) => m.material))];
  const pick = (r: GateReading | null, material: string): GateMaterialFacts | undefined => r?.materials.find((m) => m.material === material);
  const materials: GateMaterialDelta[] = names.map((material) => {
    const x = pick(a, material);
    const y = pick(b, material);
    return {
      material,
      required: x?.required ?? y?.required ?? 0,
      thisFulfilled: x?.fulfilled ?? null,
      otherFulfilled: y?.fulfilled ?? null,
      ahead: x && y ? x.fulfilled - y.fulfilled : null,
      thisAsk: x?.ask ?? null,
      otherAsk: y?.ask ?? null,
      thisCeiling: x?.ceiling ?? null,
      otherCeiling: y?.ceiling ?? null,
    };
  });
  const firstHour = Math.floor(Math.min(thisReadings[0]?.elapsedH ?? Infinity, otherReadings[0]?.elapsedH ?? Infinity));
  const hourly: GateComparison["hourly"] = [];
  if (Number.isFinite(firstHour)) {
    for (let hour = firstHour; hour <= Math.floor(atElapsedH); hour++) {
      // The reading that closes the hour: the last one before hour + 1.
      hourly.push({ hour, this: fulfilledMap(readingAtOrBefore(thisReadings, hour + 0.999)), other: fulfilledMap(readingAtOrBefore(otherReadings, hour + 0.999)) });
    }
  }
  const notes: string[] = [];
  if (!a) notes.push("this week has no gate reading at or before that hour");
  if (!b) notes.push("the other week has no gate reading at or before that hour (readings exist only for weeks recorded from the 2026-11-10 deploy on)");
  return {
    atElapsedH,
    thisReadingAt: a?.at ?? null,
    otherReadingAt: b?.at ?? null,
    thisDecision: a?.decision ?? null,
    otherDecision: b?.decision ?? null,
    thisCarriers: a ? a.carriers : null,
    otherCarriers: b ? b.carriers : null,
    materials,
    hourly,
    notes,
  };
}
