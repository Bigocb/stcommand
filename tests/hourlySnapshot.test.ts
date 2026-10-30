import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_KIND, fleetPoints, hourOf, hourlySnapshotEvent } from "../src/engine/hourlySnapshot.js";

const facts = { keepers: 400, keepersParked: 30, liveSystems: 37, stagedSystems: 3, scoutedSystems: 60, keeperCallsPerMin: 65.84, ships: 480, traders: 23, wallet: 70_000_000 };

describe("hourly snapshot", () => {
  it("is an engine action event of its own kind carrying every fact, the call rate to one decimal", () => {
    const e = hourlySnapshotEvent(facts, "2026-10-30T19:00:00.000Z");
    assert.equal(e.kind, SNAPSHOT_KIND);
    assert.equal(e.actor, "engine");
    assert.equal((e.observed as any).liveSystems, 37);
    assert.equal((e.observed as any).keeperCallsPerMin, 65.8);
  });
  it("hourOf is stable inside an hour, so a restart does not write a second reading", () => {
    const t = Date.parse("2026-10-30T19:05:00Z");
    assert.equal(hourOf(t), hourOf(t + 54 * 60_000));
    assert.equal(hourOf(t) + 1, hourOf(t + 60 * 60_000));
  });
  it("fleetPoints sets readings on the ledger's hour axis, the last of an hour standing, empty hours null", () => {
    const start = "2026-10-30T10:00:00.000Z";
    const rows = [
      { at: "2026-10-30T10:30:00.000Z", observed: { keepers: 100, liveSystems: 5, keeperCallsPerMin: 20 } },
      { at: "2026-10-30T10:50:00.000Z", observed: { keepers: 110, liveSystems: 6, keeperCallsPerMin: 22 } },
      { at: "2026-10-30T13:05:00.000Z", observed: { keepers: 150, liveSystems: 9, keeperCallsPerMin: 30 } },
      { at: "2026-10-29T09:00:00.000Z", observed: { keepers: 1, liveSystems: 1, keeperCallsPerMin: 1 } },
    ];
    const p = fleetPoints(rows, start, 4);
    assert.deepEqual(p.map((x) => x.live), [6, null, null, 9, null]);
    assert.deepEqual(p.map((x) => x.keepers), [110, null, null, 150, null]);
    assert.equal(fleetPoints(rows, null, 2).every((x) => x.live === null), true);
  });
});
