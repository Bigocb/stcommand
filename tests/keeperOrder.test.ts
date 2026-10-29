import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { yardsFirst } from "../src/engine/keeperOrder.js";

describe("yardsFirst", () => {
  it("moves yard markets to the front and keeps each group's order", () => {
    const out = yardsFirst(["X1-A-B1", "X1-A-A2", "X1-A-C3", "X1-A-D44"], new Set(["X1-A-A2", "X1-A-D44"]));
    assert.deepEqual(out, ["X1-A-A2", "X1-A-D44", "X1-A-B1", "X1-A-C3"]);
  });
  it("leaves the list alone with no yards, and drops nothing", () => {
    const list = ["X1-A-B1", "X1-A-C3"];
    assert.deepEqual(yardsFirst(list, new Set()), list);
    assert.equal(yardsFirst(list, new Set(["X1-A-B1"])).length, 2);
  });
});
