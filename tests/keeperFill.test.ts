import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickFillBatch, type FillSystem } from "../src/engine/keeperFill.js";

const sys = (system: string, covered: number, candidates: string[]): FillSystem => ({ system, covered, candidates });

describe("keeper fill batch", () => {
  const systems = [
    sys("X1-A", 8, ["A1", "A2", "A3"]), // 8 of 11 covered
    sys("X1-B", 2, ["B1", "B2", "B3", "B4"]), // 2 of 6: least covered
    sys("X1-C", 5, []),
    sys("X1-D", 5, ["D1"]), // 5 of 6
  ];

  it("takes one market per system per round, least-covered system first", () => {
    const r = pickFillBatch(systems, { limit: 5 });
    assert.deepEqual(r.markets, ["B1", "A1", "D1", "B2", "A2"]);
    assert.deepEqual(r.bySystem, { "X1-B": 2, "X1-A": 2, "X1-D": 1 });
    assert.equal(r.remaining, 3);
    assert.match(r.reason, /stopped by the limit of 5/);
  });

  it("stops at the keeper slots and the API room, whichever is smaller", () => {
    assert.equal(pickFillBatch(systems, { limit: 50, slots: 3 }).markets.length, 3);
    const r = pickFillBatch(systems, { limit: 50, slots: 6, apiRoom: 2 });
    assert.equal(r.markets.length, 2);
    assert.match(r.reason, /API ceiling/);
  });

  it("adds nothing with no slots or no API room, and says why", () => {
    assert.match(pickFillBatch(systems, { limit: 5, slots: 0 }).reason, /no keeper slots/);
    assert.match(pickFillBatch(systems, { limit: 5, apiRoom: 0 }).reason, /no API room/);
    assert.deepEqual(pickFillBatch(systems, { limit: 5, slots: 0 }).markets, []);
  });

  it("restricts to one system and reports when it has nothing left", () => {
    assert.deepEqual(pickFillBatch(systems, { limit: 10, system: "X1-B" }).markets, ["B1", "B2", "B3", "B4"]);
    assert.match(pickFillBatch(systems, { limit: 10, system: "X1-C" }).reason, /no uncovered/);
  });

  it("says everything is covered when no system has a candidate", () => {
    const r = pickFillBatch([sys("X1-A", 4, [])], { limit: 5 });
    assert.deepEqual(r.markets, []);
    assert.match(r.reason, /covered/);
  });
});
