import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nearestShipyard } from "../src/engine/shipyardNearest.js";

describe("nearestShipyard", () => {
  it("is undefined with no shipyards", () => {
    assert.equal(nearestShipyard({ x: 0, y: 0 }, []), undefined);
  });

  it("picks the closest yard by straight-line distance", () => {
    const pick = nearestShipyard({ x: 0, y: 0 }, [
      { symbol: "X1-A-Y1", x: 30, y: 40 },
      { symbol: "X1-A-Y2", x: 5, y: 5 },
      { symbol: "X1-A-Y3", x: -100, y: 0 },
    ]);
    assert.equal(pick?.symbol, "X1-A-Y2");
    assert.equal(pick?.distance, 7);
  });

  it("breaks ties on the alphabetically first symbol", () => {
    const pick = nearestShipyard({ x: 0, y: 0 }, [
      { symbol: "X1-A-Y9", x: 3, y: 4 },
      { symbol: "X1-A-Y2", x: -3, y: 4 },
    ]);
    assert.equal(pick?.symbol, "X1-A-Y2");
  });

  it("gives a one-line reason naming the count and distance", () => {
    const pick = nearestShipyard({ x: 0, y: 0 }, [{ symbol: "X1-A-Y1", x: 6, y: 8 }]);
    assert.equal(pick?.reason, "closest of 1 shipyard in the system, 10 units away");
  });

  it("picks a yard the ship is already standing at at distance zero", () => {
    const pick = nearestShipyard({ x: 12, y: -4 }, [
      { symbol: "X1-A-Y1", x: 50, y: 50 },
      { symbol: "X1-A-Y2", x: 12, y: -4 },
    ]);
    assert.equal(pick?.symbol, "X1-A-Y2");
    assert.equal(pick?.distance, 0);
  });
});
