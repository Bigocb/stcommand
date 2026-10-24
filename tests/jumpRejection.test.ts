import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gateFromJumpRejection } from "../src/engine/jumpRejection.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { GalaxyAtlas } from "../src/engine/galaxy.js";

const ends = { origin: "X1-RB54-AA7A", destination: "X1-JM97-I57" };

describe("which gate a rejected jump is about", () => {
  it("flags the gate the game names: the 2026-10-24 JM97 message flags JM97, not the RB54 hub gate the ship stood at", () => {
    assert.equal(gateFromJumpRejection("Failed to execute jump. Destination jump gate X1-JM97-I57 is under construction.", ends), "X1-JM97-I57");
    assert.equal(gateFromJumpRejection("Failed to execute jump. Destination jump gate x1-jm97-i57 is under construction.", ends), "X1-JM97-I57", "case does not matter");
    assert.equal(gateFromJumpRejection("jump gate X1-RB54-AA7A is under construction", ends), "X1-RB54-AA7A", "a message naming the origin flags the origin");
  });

  it("flags the destination end when the message says destination but names no gate", () => {
    assert.equal(gateFromJumpRejection("Destination gate is under construction", ends), "X1-JM97-I57");
  });

  it("keeps the old behaviour for everything else gate-related: the origin", () => {
    assert.equal(gateFromJumpRejection("The jump gate is under construction", ends), "X1-RB54-AA7A");
    assert.equal(gateFromJumpRejection("Waypoint X1-A-B is not connected to the current location", ends), "X1-RB54-AA7A");
    assert.equal(gateFromJumpRejection("jump gate construction is not complete", ends), "X1-RB54-AA7A");
  });

  it("says nothing about errors that are not about a gate", () => {
    assert.equal(gateFromJumpRejection("Ship is not currently in orbit", ends), undefined);
    assert.equal(gateFromJumpRejection("Rate limit exceeded", ends), undefined);
    assert.equal(gateFromJumpRejection("", ends), undefined);
  });
});

/** The trader's handler, with a real atlas: the rejection must correct the destination in the cache and leave the finished origin gate alone. */
describe("TraderAgent.jumpToSystem: a construction rejection corrects the right gate", () => {
  function rig() {
    const ship = {
      symbol: "T-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-RB54-AA7A", systemSymbol: "X1-RB54", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 40, units: 0, inventory: [] }, fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const flagged: string[] = [];
    const atlas = {
      gatesTo: () => ["X1-RB54-AA7A"],
      loadSystem: async () => ({ symbol: "X1-JM97", waypoints: [{ symbol: "X1-JM97-I57", type: "JUMP_GATE" }], jumpGates: [], markets: [], shipyards: [] }),
      recordGateNotComplete: (g: string) => { flagged.push(g); },
    };
    const trader = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0, getShip: async () => ship, orbitShip: async () => ({ nav: ship.nav }),
        jumpShip: async () => { throw new Error("Failed to execute jump. Destination jump gate X1-JM97-I57 is under construction."); },
      } as any,
      log: () => {}, atlas: atlas as any,
    } as any);
    (trader as any).navigateTo = async () => {};
    (trader as any).topOffHere = async () => {};
    return { trader, flagged };
  }

  it("flags the destination gate only, and still retires the route to that system", async () => {
    const { trader, flagged } = rig();
    await assert.rejects(() => (trader as any).jumpToSystem("X1-JM97", "X1-JM97-I57"), /under construction/);
    assert.deepEqual(flagged, ["X1-JM97-I57"], "not X1-RB54-AA7A");
  });
});

describe("the cache after the correction (real atlas)", () => {
  it("a gate recorded complete is closed again by recordGateNotComplete, and the origin hub stays open", () => {
    const atlas: any = new GalaxyAtlas({} as any);
    atlas.gateConstruction.set("X1-JM97-I57", true);
    atlas.gateConstruction.set("X1-RB54-AA7A", true);
    atlas.recordGateNotComplete("X1-JM97-I57");
    assert.equal(atlas.gateConstruction.get("X1-JM97-I57"), false);
    assert.equal(atlas.gateConstruction.get("X1-RB54-AA7A"), true, "the finished hub gate is untouched");
  });
});
