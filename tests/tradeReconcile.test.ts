import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * Step 3 of docs/control-plane-data-plane.md, for the role that never got it.
 *
 * A trade used to run straight through — navigate, dock, buy, navigate, dock,
 * sell — with no diff between statements. Under the scheduler that shape
 * cannot complete: navigateTo() raises NavigationPending the moment the ship
 * enters transit, so the tick ended at the buy and the sell half never ran.
 * The leftover sweep finished routes instead, at whatever market was nearest.
 *
 * Now each tick re-derives the trip from two observed facts — what is in the
 * hold, and where the ship is standing — so arrival is a precondition for
 * selling rather than an assumption inherited from the line above.
 */

const leg = { good: "MEDICINE", buyAt: "X1-A-BUY", sellAt: "X1-A-SELL", buyPrice: 100, sellPrice: 900 };

function shipAt(waypoint: string, cargo: { symbol: string; units: number }[] = []): Ship {
  return {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: waypoint, systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: cargo.reduce((n, c) => n + c.units, 0), inventory: cargo },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
}

function agent(ship: Ship, over: Record<string, unknown> = {}) {
  const navigated: string[] = [];
  const sold: { good: string; units: number }[] = [];
  const a = new TraderAgent(ship, {
    api: {
      getCallCount: () => 0,
      getShip: async () => ship,
      dockShip: async () => ({}),
      sellCargo: async (_s: string, good: string, units: number) => {
        sold.push({ good, units });
        return { cargo: { capacity: 40, units: 0, inventory: [] }, transaction: { pricePerUnit: 900, totalPrice: 900 * units } };
      },
    } as never,
    log: () => {},
    ...over,
  } as never);
  (a as never as { navigateTo(w: string): Promise<void> }).navigateTo = async (w: string) => { navigated.push(w); };
  (a as never as { liveSellPrice(): Promise<undefined> }).liveSellPrice = async () => undefined;
  (a as never as { heldRoute: Map<string, unknown> }).heldRoute.set("MEDICINE", leg);
  (a as never as { heldCost: Map<string, number> }).heldCost.set("MEDICINE", 100);
  return { a, navigated, sold };
}

describe("a trip is re-derived from the hold and the ship's position", () => {
  it("navigates toward the sell market and sells nothing while away from it", async () => {
    const { a, navigated, sold } = agent(shipAt("X1-A-BUY", [{ symbol: "MEDICINE", units: 20 }]));
    const acted = await (a as never as { deliverHeldCargo(): Promise<boolean | undefined> }).deliverHeldCargo();

    assert.equal(acted, true, "carrying cargo is the whole job this tick");
    assert.deepEqual(navigated, ["X1-A-SELL"]);
    assert.deepEqual(sold, [], "selling before arrival is the bug this closes");
  });

  it("sells once the ship is standing at the sell market", async () => {
    const { a, navigated, sold } = agent(shipAt("X1-A-SELL", [{ symbol: "MEDICINE", units: 20 }]));
    await (a as never as { deliverHeldCargo(): Promise<boolean | undefined> }).deliverHeldCargo();

    assert.deepEqual(navigated, [], "already there — no move needed");
    assert.deepEqual(sold, [{ good: "MEDICINE", units: 20 }]);
  });

  it("releases the pin after selling, so the next trip starts clean", async () => {
    const { a } = agent(shipAt("X1-A-SELL", [{ symbol: "MEDICINE", units: 20 }]));
    await (a as never as { deliverHeldCargo(): Promise<boolean | undefined> }).deliverHeldCargo();
    assert.equal((a as never as { heldRoute: Map<string, unknown> }).heldRoute.has("MEDICINE"), false);
  });

  it("reports nothing under way when the hold is empty, so a new trip can start", async () => {
    const { a } = agent(shipAt("X1-A-SELL", []));
    assert.equal(await (a as never as { deliverHeldCargo(): Promise<boolean | undefined> }).deliverHeldCargo(), undefined);
  });

  it("leaves unpinned cargo alone — that is the sweep's job, not a trip", async () => {
    const { a, navigated, sold } = agent(shipAt("X1-A-BUY", [{ symbol: "IRON", units: 5 }]));
    assert.equal(await (a as never as { deliverHeldCargo(): Promise<boolean | undefined> }).deliverHeldCargo(), undefined);
    assert.deepEqual(navigated, []);
    assert.deepEqual(sold, []);
  });

  it("holds rather than selling below the loss floor, without dropping the pin", async () => {
    const { a, sold } = agent(shipAt("X1-A-SELL", [{ symbol: "MEDICINE", units: 20 }]));
    (a as never as { liveSellPrice(): Promise<number> }).liveSellPrice = async () => 10;
    (a as never as { exceedsLossFloor(): Promise<boolean> }).exceedsLossFloor = async () => true;

    assert.equal(await (a as never as { deliverHeldCargo(): Promise<boolean | undefined> }).deliverHeldCargo(), true);
    assert.deepEqual(sold, [], "a loss floor must stop the sale");
    assert.equal((a as never as { heldRoute: Map<string, unknown> }).heldRoute.has("MEDICINE"), true, "and the trip is still live");
  });
});
