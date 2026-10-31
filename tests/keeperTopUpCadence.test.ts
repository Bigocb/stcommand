import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

function fake(lastAddAgoMin: number | undefined, factsCalls: { n: number }) {
  const book = { topUp: new Map<string, number>() };
  if (lastAddAgoMin !== undefined) book.topUp.set("lastAdd", Date.now() - lastAddAgoMin * 60_000);
  const self: any = {
    store: {}, tenantId: "t", lastTopUpCheckAt: 0,
    doctrine: { isEnabledOr: () => true, value: (k: string) => (k === "keeperTopUpPerHour" ? 8 : 90) },
    timers: () => ({ load: async () => {}, save: async () => {}, book }),
    keeperSlotsUsed: () => 10,
    topUpFacts: async () => { factsCalls.n++; return { systems: [], viable: new Map(), pending: 0, load: 0, perKeeper: 0.2, listedPending: 0 }; },
    keeperNote: () => {}, log: () => {}, topUpNoteAt: "",
  };
  return self;
}
const run = (self: any) => (FleetManager.prototype as any).maybeTopUpKeepers.call(self);

describe("keeper top-up cadence", () => {
  it("does not read the facts before an addition is due", async () => {
    const calls = { n: 0 };
    const self = fake(5, calls); // gap at 8 an hour = 7.5 min
    await run(self);
    assert.equal(calls.n, 0);
    assert.match(self.topUpLast.reason, /one every 8 min|one every 7 min/);
  });

  it("reads the facts once when due, then waits about 5 minutes if nothing was added", async () => {
    const calls = { n: 0 };
    const self = fake(8, calls);
    await run(self);
    assert.equal(calls.n, 1);
    assert.ok(self.lastTopUpCheckAt > Date.now() + 3 * 60_000);
    await run(self);
    assert.equal(calls.n, 1, "not read again inside the wait");
  });
});
