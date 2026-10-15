import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffKeyed, emptyDiff } from "../src/engine/liveDiff.js";

type Row = { symbol: string; doing: string; cooldown: number };
const key = (r: Row) => r.symbol;
// The same comparison the live feed uses for the fleet summary: cooldown seconds in 15-second steps.
const compare = (r: Row) => ({ ...r, cooldown: Math.ceil(r.cooldown / 15), doing: r.doing.startsWith("cooldown ") ? "cooldown" : r.doing });

describe("keyed live diff", () => {
  it("sends new and changed rows and names removed ones", () => {
    const a = diffKeyed(new Map(), [{ symbol: "S-1", doing: "docked", cooldown: 0 }, { symbol: "S-2", doing: "in orbit", cooldown: 0 }], key);
    assert.equal(a.diff.changed.length, 2);
    const b = diffKeyed(a.next, [{ symbol: "S-1", doing: "transit → X1-A-2", cooldown: 0 }], key);
    assert.deepEqual(b.diff.changed.map((r) => r.symbol), ["S-1"]);
    assert.deepEqual(b.diff.removed, ["S-2"]);
  });

  it("sends nothing when nothing changed", () => {
    const rows = [{ symbol: "S-1", doing: "docked", cooldown: 0 }];
    const a = diffKeyed(new Map(), rows, key);
    assert.ok(emptyDiff(diffKeyed(a.next, rows, key).diff));
  });

  it("resends a cooling ship at most once per 15-second step, not every pass", () => {
    const a = diffKeyed(new Map(), [{ symbol: "S-1", doing: "cooldown 44s", cooldown: 44 }], key, compare);
    const b = diffKeyed(a.next, [{ symbol: "S-1", doing: "cooldown 42s", cooldown: 42 }], key, compare);
    assert.ok(emptyDiff(b.diff), "44 s and 42 s are in the same step");
    const c = diffKeyed(b.next, [{ symbol: "S-1", doing: "cooldown 29s", cooldown: 29 }], key, compare);
    assert.equal(c.diff.changed.length, 1, "crossing into the next step resends it");
  });
});
