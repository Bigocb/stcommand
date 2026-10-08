import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetState } from "../src/engine/state.js";

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
