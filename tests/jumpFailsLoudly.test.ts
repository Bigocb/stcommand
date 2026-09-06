import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * A movement primitive that cannot move the ship must not return normally.
 *
 * jumpToSystem() used to log and return on every failure, which reads to the
 * caller exactly like arrival — and the caller's next moves are ensureDocked()
 * and a purchase or sale. DAGGER-F ran that loop for over twenty minutes:
 * sitting in X1-ZU53, "no jump gate from X1-ZU53 to X1-TV75", then buying at
 * X1-RD37-D20E and selling at X1-TV75-X20F, two markets in two other systems
 * it was not at, losing 9,036c a cycle.
 */

function trader(atlas: any, assigned?: any): TraderAgent {
  const ship = {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-ZU53-A1", systemSymbol: "X1-ZU53", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  return new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    log: () => {},
    atlas,
    ...(assigned ? { assignedRoute: () => assigned } : {}),
  } as any);
}

describe("a jump that cannot happen fails loudly", () => {
  it("throws when there is no gate to the target system", async () => {
    const a = trader({ gatesTo: () => [], scanJumpGates: async () => {}, canJump: () => true });
    await assert.rejects(
      () => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"),
      /no jump gate from X1-ZU53 to X1-TV75/,
      "returning here let the caller buy and sell at the wrong market",
    );
  });

  it("throws when the target system has no gate waypoint", async () => {
    const a = trader({
      gatesTo: () => ["X1-ZU53-GATE"],
      loadSystem: async () => ({ waypoints: [{ symbol: "X1-TV75-A1", type: "PLANET" }] }),
    });
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"), /no jump gate waypoint/);
  });

  it("throws when the atlas returns a gate outside the current system", async () => {
    const a = trader({ gatesTo: () => ["X1-OTHER-GATE"] });
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"), /is not in X1-ZU53/);
  });

  it("throws with no atlas at all, rather than reporting arrival", async () => {
    const a = trader(undefined);
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"), /no galaxy atlas/);
  });

  it("retires the route so the dispatcher stops re-issuing an unreachable leg", async () => {
    // Otherwise the throw is honest but useless: the same leg comes back next
    // tick and the ship fails on it forever — the same loop with an error line
    // where the loss used to be.
    const assigned = { good: "ANTIMATTER", role: "direct", buyAt: "X1-RD37-D20E", sellAt: "X1-TV75-X20F", buyPrice: 5919, sellPrice: 5417 };
    const a = trader({ gatesTo: () => [], scanJumpGates: async () => {} }, assigned);
    await assert.rejects(() => (a as any).jumpToSystem("X1-TV75", "X1-TV75-X20F"));
    assert.ok((a as any).deadRoutes.has("ANTIMATTER@X1-RD37-D20E"), "the unreachable leg must not be retried");
  });
});
