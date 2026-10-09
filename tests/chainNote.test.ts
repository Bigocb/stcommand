import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module, no types
import { chainNote } from "../public/shared/domain.js";

describe("chainNote (route label suffix for the follow-on / circuit)", () => {
  it("says nothing without a follow-on or circuit", () => {
    assert.equal(chainNote(undefined), "");
    assert.equal(chainNote({ good: "G", role: "direct" }), "");
  });
  it("names the follow-on trip", () => {
    const a = { followOn: { good: "ALUMINUM", buyAt: "X1-JX83-H55", sellAt: "X1-JX83-D44", score: 1 } };
    assert.equal(chainNote(a), " · then ALUMINUM JX83-H55 → JX83-D44");
  });
  it("shows a circuit's position, and prefers it over a follow-on", () => {
    const leg1 = { circuit: { leg: 1, leg2: { good: "CLOTHING", buyAt: "a", sellAt: "b", score: 1 }, explain: "" }, followOn: { good: "X", buyAt: "X1-A-1", sellAt: "X1-A-2", score: 1 } };
    assert.equal(chainNote(leg1), " · circuit 1/2, back via CLOTHING");
    assert.equal(chainNote({ circuit: { ...leg1.circuit, leg: 2 } }), " · circuit 2/2");
  });
});
