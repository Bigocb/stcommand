import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeTag } from "../src/engine/routeTag.js";

describe("routeTag", () => {
  const a = { good: "DIAMONDS", buyAt: "B7", sellAt: "H60", source: "auto", circuit: { leg: 1 } };
  it("names the route, who chose it and the circuit leg", () => {
    assert.equal(routeTag("DIAMONDS", { buyAt: "B7", sellAt: "H60" }, a), "B7>H60 auto circuit1");
  });
  it("prefers the pinned route over the live assignment", () => {
    assert.equal(routeTag("DIAMONDS", { buyAt: "B7", sellAt: "K100" }, { ...a, circuit: undefined }), "B7>K100 auto");
  });
  it("ignores an assignment for another good", () => {
    assert.equal(routeTag("SILVER", { buyAt: "B7", sellAt: "H60" }, a), "B7>H60");
  });
  it("falls back to the assignment when nothing is pinned, and is undefined with neither", () => {
    assert.equal(routeTag("DIAMONDS", undefined, a), "B7>H60 auto circuit1");
    assert.equal(routeTag("DIAMONDS", undefined, undefined), undefined);
  });
});
