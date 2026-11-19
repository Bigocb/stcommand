import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCOUT_PROBE_POLICY, decideScoutProbe } from "../src/engine/stagedScoutProbe.js";

// Gate hops between systems, as a lookup table (undefined = no path).
const table: Record<string, number> = { "X1-FR50>X1-ZU90": 4, "X1-RZ24>X1-ZU90": 1, "X1-FR50>X1-ZK9": 9 };
const hops = (a: string, b: string) => table[`${a}>${b}`];
const yards = [
  { yard: "X1-FR50-B14D", system: "X1-FR50", price: 27_283 },
  { yard: "X1-RZ24-B22Z", system: "X1-RZ24", price: 28_704 },
];
const on = { ...DEFAULT_SCOUT_PROBE_POLICY, maxCost: 80_000 };

describe("decideScoutProbe (pure)", () => {
  it("off (maxCost 0) buys nothing: today's behaviour", () => {
    assert.deepEqual(decideScoutProbe([{ system: "X1-ZU90" }], yards, hops, 5_000_000, DEFAULT_SCOUT_PROBE_POLICY), { notes: [] });
  });

  it("no free tour ship: buys at the yard cheapest counting jumps (RZ24, 1 jump) over the cheaper sticker 4 jumps away", () => {
    const d = decideScoutProbe([{ system: "X1-ZU90" }], yards, hops, 2_000_000, on);
    assert.equal(d.buy?.yard, "X1-RZ24-B22Z");
    assert.equal(d.buy?.cost, 28_704 + 6_500);
    assert.match(d.buy!.reason, /no free tour ship/);
  });

  it("a free tour ship within 2 hops goes instead; 3 hops away and a probe is bought", () => {
    assert.equal(decideScoutProbe([{ system: "X1-ZU90", shipHops: 2 }], yards, hops, 2_000_000, on).buy, undefined);
    assert.equal(decideScoutProbe([{ system: "X1-ZU90", shipHops: 3 }], yards, hops, 2_000_000, on).buy?.system, "X1-ZU90");
  });

  it("over the cost limit or under the cash floor: no buy, and the note says why", () => {
    const far = decideScoutProbe([{ system: "X1-ZK9" }], yards, hops, 2_000_000, on);
    assert.equal(far.buy, undefined);
    assert.match(far.notes[0]!, /over the 80000 limit/);
    const poor = decideScoutProbe([{ system: "X1-ZU90" }], yards, hops, 520_000, on);
    assert.equal(poor.buy, undefined);
    assert.match(poor.notes[0]!, /under 500000/);
  });

  it("one a pass: the first system that qualifies", () => {
    const d = decideScoutProbe([{ system: "X1-ZK9" }, { system: "X1-ZU90" }, { system: "X1-ZU90" }], yards, hops, 2_000_000, on);
    assert.equal(d.buy?.system, "X1-ZU90");
    assert.equal(d.notes.length, 1, "ZK9 noted as too expensive, then ZU90 bought and the loop stops");
  });

  it("no yard with a path: noted, nothing bought", () => {
    const d = decideScoutProbe([{ system: "X1-NOWHERE" }], yards, hops, 2_000_000, on);
    assert.equal(d.buy, undefined);
    assert.match(d.notes[0]!, /no yard/);
  });
});
