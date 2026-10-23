import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * navigateTo() asks the atlas for a path from cache only. A system this process never loaded reads as "no gate", so a
 * loaded ship with a perfectly open route sat retrying "no verified gate path" every 15 seconds (THEOREM-BE, 2026-10-23,
 * 18:30 to 21:19). It now loads and checks the neighbourhood once, rate-limited per pair, before giving up.
 */
function trader(atlas: any): TraderAgent {
  const ship = {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-ZR49-D22F", systemSymbol: "X1-ZR49", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 225, units: 80, inventory: [{ symbol: "CLOTHING", units: 80 }] },
    fuel: { current: 2300, capacity: 2300 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  return new TraderAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: () => {}, atlas } as any);
}

describe("navigateTo warms the path before declaring a destination unreachable", () => {
  it("loads the neighbourhood and carries on when that makes a path appear", async () => {
    let known: string[] | undefined;
    let warmed = 0;
    const a = trader({
      maxPositioningHops: 10, canJump: () => false, gatesTo: () => [], scanJumpGates: async () => {},
      jumpPath: () => known,
      warmJumpPath: async () => { warmed++; known = ["X1-ZR49", "X1-JM61", "X1-SU37"]; return known; },
    });
    await assert.rejects(() => (a as any).navigateTo("X1-SU37-D51"), /no jump gate from X1-ZR49 to X1-JM61/, "it got past the path check and tried the first hop");
    assert.equal(warmed, 1);
  });

  it("still reports no path when warming finds none, and does not re-warm the same pair for ten minutes", async () => {
    let warmed = 0;
    const a = trader({
      maxPositioningHops: 10, canJump: () => false, gatesTo: () => [], scanJumpGates: async () => {},
      jumpPath: () => undefined,
      warmJumpPath: async () => { warmed++; return undefined; },
    });
    await assert.rejects(() => (a as any).navigateTo("X1-SU37-D51"), /no verified gate path \(<= 10 hops\) from X1-ZR49 to X1-SU37/);
    await assert.rejects(() => (a as any).navigateTo("X1-SU37-D51"), /no verified gate path/);
    assert.equal(warmed, 1, "the retry loop does not turn into an API-call loop");
  });
});
