import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillFactor, fillNote, fillShare } from "../src/engine/fillFit.js";

describe("fillFit", () => {
  it("is 1 when off or when depth is unknown", () => {
    assert.equal(fillFactor(48, 225, { weightPct: 0 }), 1);
    assert.equal(fillFactor(undefined, 225, { weightPct: 50 }), 1);
    assert.equal(fillFactor(48, 225), 1, "default policy is off");
  });
  it("scales by the share of the hold filled, never above 1", () => {
    assert.equal(fillShare(48, 225)!.toFixed(3), (48 / 225).toFixed(3));
    assert.equal(fillFactor(300, 225, { weightPct: 50 }), 1);
    assert.equal(fillFactor(45, 225, { weightPct: 100 }), 0.2);
    assert.equal(fillFactor(45, 225, { weightPct: 50 }), 0.6);
  });
  it("explains itself", () => {
    assert.equal(fillNote(45, 225, { weightPct: 50 }), "fills 45/225 (20%), score x0.60");
    assert.equal(fillNote(225, 225, { weightPct: 50 }), "");
  });
});
