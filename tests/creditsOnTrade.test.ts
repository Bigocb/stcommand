import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetState } from "../src/engine/state.js";
import { SpaceTradersAPI } from "../src/core/client.js";

// A trade response carries the wallet; the dashboard's balance moves at the trade, not at the next agent read.
describe("FleetState.setCredits", () => {
  it("moves the displayed balance without an agent read", () => {
    const s = new FleetState();
    s.update({ agent: { symbol: "A", credits: 100, shipCount: 1, headquarters: "X1-AA-A1" } as never });
    s.setCredits(250);
    assert.equal(s.get().agent?.credits, 250);
    assert.equal(s.get().agent?.symbol, "A");
  });
  it("ignores a trade before the first agent read", () => {
    const s = new FleetState();
    s.setCredits(250);
    assert.equal(s.get().agent, null);
  });
});

// The same response carries the ship's new hold, so the dashboard's cargo moves with its balance.
describe("cargo from a trade response", () => {
  const hold = (units: number) => ({ capacity: 80, units, inventory: [{ symbol: "IRON", name: "Iron", description: "", units }] });

  it("FleetState.setShipCargo replaces only that ship's hold", () => {
    const s = new FleetState();
    s.update({ ships: [{ symbol: "A-1", cargo: hold(0) }, { symbol: "A-2", cargo: hold(5) }] as never });
    s.setShipCargo("A-1", hold(72) as never);
    assert.equal(s.get().ships[0]!.cargo.units, 72);
    assert.equal(s.get().ships[1]!.cargo.units, 5);
    s.setShipCargo("NOPE", hold(1) as never); // unknown ship: no change, no throw
    assert.equal(s.get().ships.length, 2);
  });

  it("the API reports credits and cargo together after a buy and a sell", async () => {
    const fake = { post: async () => ({ agent: { credits: 573_353 }, cargo: hold(72), transaction: {} }) } as never;
    const api = new SpaceTradersAPI(fake, "t");
    const seen: string[] = [];
    api.onCredits = (c) => seen.push(`credits ${c}`);
    api.onCargo = (sym, c) => seen.push(`cargo ${sym} ${c.units}`);
    await api.purchaseCargo("A-1", "IRON", 72);
    await api.sellCargo("A-1", "IRON", 72);
    assert.deepEqual(seen, ["credits 573353", "cargo A-1 72", "credits 573353", "cargo A-1 72"]);
  });
});
