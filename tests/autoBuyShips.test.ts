import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { DOCTRINE_CATALOG } from "../src/engine/doctrine.js";

/**
 * 2026-10-25: the engine's own hull buys (a "priority" tour shuttle card, miner targets, scored picks) ran beside the opening tasks.
 * `autoBuyShips` off hands every hull purchase to tasks and the operator; on (the default) leaves today's behaviour.
 */
function fleetWith(autoBuy: boolean) {
  const touched: string[] = [];
  const fleet = new FleetManager({ api: { onMarket: () => {} } as any }) as any;
  fleet.doctrine = { isEnabledOr: (k: string, d: boolean) => (k === "autoBuyShips" ? autoBuy : d), value: () => 0 };
  fleet.cachedCredits = async () => { touched.push("credits"); return 0; };
  fleet.api = { getShipyard: async () => { touched.push("yard"); return { ships: [] }; } };
  return { fleet, touched };
}

describe("autoBuyShips", () => {
  for (const fn of ["maybeBuyShip", "maybeBuyScout", "maybeBuySiphoner"]) {
    it(`${fn} does nothing at all while the clause is off`, async () => {
      const { fleet, touched } = fleetWith(false);
      await fleet[fn]();
      assert.deepEqual(touched, []);
    });
  }
  it("while on, maybeBuyShip goes on to look at credits as before", async () => {
    const { fleet, touched } = fleetWith(true);
    await fleet.maybeBuyShip();
    assert.ok(touched.includes("credits"));
  });
  it("ships on by default", () => {
    const d = DOCTRINE_CATALOG.find((c) => c.key === "autoBuyShips")!;
    assert.equal(d.enabled, true);
  });
});
