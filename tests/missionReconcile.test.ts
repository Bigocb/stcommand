import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MissionManager } from "../src/engine/mission.js";

/**
 * An active mission used to re-read its construction site on every ~2s
 * coordinator pass, for as long as it existed: about 10 of the 90 calls a
 * minute the whole fleet gets, even while cash-floor or recovery pacing held
 * every purchase. Progress only moves when something is supplied, so it now
 * re-reads every 30s (and straight after a delivery).
 */

function countingApi(isComplete = false) {
  const calls = { getConstruction: 0 };
  const api = {
    getConstruction: async () => {
      calls.getConstruction += 1;
      return { isComplete, materials: [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }] };
    },
  } as any;
  return { api, calls };
}

const noSources = { listBuyers: async () => [], discoverBuyers: async () => [] };

describe("MissionManager active reconcile cadence", () => {
  it("does not re-read the site on every tick", async () => {
    const { api, calls } = countingApi();
    const mgr = new MissionManager({ api, ...noSources });
    await mgr.startConstruction("X1-A-I1");
    const afterStart = calls.getConstruction;

    for (let i = 0; i < 20; i += 1) await mgr.tick();

    assert.ok(calls.getConstruction - afterStart <= 1, `20 ticks should read the site once, read it ${calls.getConstruction - afterStart}x`);
  });

  it("reads it again once the interval has passed", async () => {
    const { api, calls } = countingApi();
    const mgr = new MissionManager({ api, ...noSources });
    await mgr.startConstruction("X1-A-I1");
    await mgr.tick();
    const afterFirst = calls.getConstruction;

    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      await mgr.tick();
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.getConstruction, afterFirst + 1);
  });

  it("still notices a finished gate on the read it does make", async () => {
    const { api } = countingApi(true);
    const mgr = new MissionManager({ api, ...noSources });
    await mgr.startConstruction("X1-A-I1").catch(() => {});
    await mgr.tick();
    await mgr.tick();
    const mission = (await mgr.list()).find((m) => m.targetWaypoint === "X1-A-I1");
    assert.ok(!mission || mission.status !== "active", "a complete gate must not stay an active mission");
  });
});
