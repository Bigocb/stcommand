import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_SNAPSHOT_KIND, compareGateWeeks, gateReadings, gateSnapshotEvent, readingAtOrBefore, slotOf, type GateSnapshotFacts } from "../src/engine/gateSnapshot.js";

const facts = (fab: number, circ: number, over: Partial<GateSnapshotFacts> = {}): GateSnapshotFacts => ({
  waypoint: "X1-AA-I1",
  status: "active",
  paused: false,
  decision: "run",
  reason: "can buy: FAB_MATS 2,400 within 2,500",
  carriers: [{ ship: "S-1", step: "source", material: "FAB_MATS" }],
  wallet: 900_000,
  materials: [
    { material: "FAB_MATS", required: 1600, fulfilled: fab, ask: 2400, ceiling: 2500 },
    { material: "ADVANCED_CIRCUITRY", required: 400, fulfilled: circ, ask: null, ceiling: null },
  ],
  ...over,
});

const row = (at: string, f: GateSnapshotFacts) => {
  const e = gateSnapshotEvent(f, at);
  return { at: e.at, subject: e.subject, observed: e.observed };
};

test("the event carries the per-material picture and the verdict", () => {
  const e = gateSnapshotEvent(facts(100, 20), "2026-11-10T04:00:00.000Z");
  assert.equal(e.kind, GATE_SNAPSHOT_KIND);
  assert.equal(e.subject, "X1-AA-I1");
  const o = e.observed as { materials: { material: string; fulfilled: number }[]; decision: string; carriers: unknown[] };
  assert.deepEqual(o.materials.map((m) => [m.material, m.fulfilled]), [["FAB_MATS", 100], ["ADVANCED_CIRCUITRY", 20]]);
  assert.equal(o.decision, "run");
  assert.equal(o.carriers.length, 1);
});

test("slotOf puts two moments in the same 15 minute slot, and not in the next", () => {
  const t = Date.parse("2026-11-10T04:02:00Z");
  assert.equal(slotOf(t), slotOf(t + 12 * 60_000));
  assert.notEqual(slotOf(t), slotOf(t + 14 * 60_000 + 1));
});

test("readings are placed on the week's own clock and sorted; rows before the start and other waypoints drop out", () => {
  const start = "2026-11-08T13:00:00.000Z";
  const rows = [
    row("2026-11-08T15:00:00.000Z", facts(50, 0)),
    row("2026-11-08T14:00:00.000Z", facts(20, 0)),
    row("2026-11-08T12:00:00.000Z", facts(1, 0)),
    row("2026-11-08T14:30:00.000Z", facts(999, 0, { waypoint: "X1-AA-OTHER" })),
  ];
  const r = gateReadings(rows, start, "X1-AA-I1");
  assert.deepEqual(r.map((x) => x.elapsedH), [1, 2]);
  assert.deepEqual(r.map((x) => x.materials[0]!.fulfilled), [20, 50]);
});

test("readingAtOrBefore gives the latest reading that early, or null before the first", () => {
  const r = gateReadings([row("2026-11-08T14:00:00.000Z", facts(20, 0)), row("2026-11-08T16:00:00.000Z", facts(90, 0))], "2026-11-08T13:00:00.000Z");
  assert.equal(readingAtOrBefore(r, 0.5), null);
  assert.equal(readingAtOrBefore(r, 2.9)!.materials[0]!.fulfilled, 20);
  assert.equal(readingAtOrBefore(r, 3)!.materials[0]!.fulfilled, 90);
});

test("compare: same elapsed hour, who is ahead, and the hourly table", () => {
  const mk = (start: string, fabs: number[]) => gateReadings(fabs.map((f, i) => row(new Date(Date.parse(start) + i * 3_600_000).toISOString(), facts(f, f / 10))), start);
  const thisWeek = mk("2026-11-08T13:00:00.000Z", [0, 100, 300, 600]);
  const lastWeek = mk("2026-11-01T13:00:00.000Z", [0, 200, 400, 500]);
  const c = compareGateWeeks(thisWeek, lastWeek, 3);
  const fab = c.materials.find((m) => m.material === "FAB_MATS")!;
  assert.deepEqual([fab.thisFulfilled, fab.otherFulfilled, fab.ahead], [600, 500, 100]);
  assert.equal(fab.thisCeiling, 2500);
  assert.deepEqual(c.hourly.map((h) => [h.hour, h.this.FAB_MATS, h.other.FAB_MATS]), [[0, 0, 0], [1, 100, 200], [2, 300, 400], [3, 600, 500]]);
  assert.deepEqual(c.notes, []);
});

test("compare: a week with no readings is said, not guessed", () => {
  const thisWeek = gateReadings([row("2026-11-08T14:00:00.000Z", facts(100, 10))], "2026-11-08T13:00:00.000Z");
  const c = compareGateWeeks(thisWeek, [], 1);
  assert.equal(c.materials.find((m) => m.material === "FAB_MATS")!.ahead, null);
  assert.equal(c.otherReadingAt, null);
  assert.match(c.notes.join(" "), /other week has no gate reading/);
});

test("compare: this week not started on the gate yet", () => {
  const lastWeek = gateReadings([row("2026-11-01T14:00:00.000Z", facts(100, 10))], "2026-11-01T13:00:00.000Z");
  const c = compareGateWeeks([], lastWeek, 5);
  assert.match(c.notes.join(" "), /this week has no gate reading/);
  assert.equal(c.materials.find((m) => m.material === "FAB_MATS")!.otherFulfilled, 100);
});

test("a malformed row does not throw", () => {
  const r = gateReadings([{ at: "2026-11-08T14:00:00.000Z", observed: { materials: [{ nonsense: true }, null] as unknown as unknown[] } }], "2026-11-08T13:00:00.000Z");
  assert.equal(r.length, 1);
  assert.deepEqual(r[0]!.materials, []);
});
