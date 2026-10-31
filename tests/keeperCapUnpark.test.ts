import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

// applyIdleParking and keeperSlotsUsed against a stand-in `this`.
function fake(opts: { max: number; polling: number; staged: number; idleParkedIn: string[] }) {
  const unparked: string[] = [];
  const notes: string[] = [];
  const idleParked = new Map(opts.idleParkedIn.map((sys, i) => [`K${i}`, sys]));
  const self: any = {
    doctrine: { isEnabledOr: () => true, value: (k: string) => (k === "keeperMaxTotal" ? opts.max : 6) },
    freshMature: { at: 0, sells: [{ waypoint: "X1-AA-M1", timestamp: new Date().toISOString() }] },
    idleParked,
    keepers: { size: opts.polling },
    stagedParked: { size: opts.staged },
    parkedShips: new Map(opts.idleParkedIn.map((_, i) => [`K${i}`, {}])),
    systemQueue: { list: () => [{ system: "X1-AA", releasedAt: Date.now() - 48 * 3_600_000 }] },
    keeperMarkets: new Map(),
    fleetStatusSummary: () => [],
    unparkShip: async (s: string) => { unparked.push(s); },
    freshNote: (m: string) => notes.push(m),
    saveFreshGate: async () => {},
  };
  self.keeperSlotsUsed = () => (FleetManager.prototype as any).keeperSlotsUsed.call(self);
  return { self, unparked, notes, idleParked };
}
const run = (self: any) => (FleetManager.prototype as any).applyIdleParking.call(self, ["X1-AA"], Date.now());

describe("keeper cap counts staged-parked keepers and gates idle unparking", () => {
  it("counts polling plus staged-parked keepers as slots used", () => {
    const { self } = fake({ max: 500, polling: 400, staged: 18, idleParkedIn: [] });
    assert.equal(self.keeperSlotsUsed(), 418);
  });

  it("keeps idle-parked keepers parked while the cap is full", async () => {
    const { self, unparked, notes, idleParked } = fake({ max: 500, polling: 498, staged: 0, idleParkedIn: ["X1-AA", "X1-AA", "X1-AA"] });
    await run(self);
    assert.deepEqual(unparked, []);
    assert.equal(idleParked.size, 3, "still marked idle-parked");
    assert.ok(notes.some((n) => /wait for a free slot/.test(n)));
  });

  it("unparks them when there is room", async () => {
    const { self, unparked } = fake({ max: 500, polling: 400, staged: 0, idleParkedIn: ["X1-AA", "X1-AA"] });
    await run(self);
    assert.equal(unparked.length, 2);
  });
});
