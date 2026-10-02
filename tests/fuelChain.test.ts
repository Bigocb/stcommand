import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuelChainReaches } from "../src/engine/fleet.js";

// Points on a line: distance is |a - b| using the number in the symbol.
const pos = (s: string) => Number(s.split("@")[1]);
const dist = (a: string, b: string) => Math.abs(pos(a) - pos(b));

describe("fuelChainReaches", () => {
  it("is true when one tank covers the leg", () => {
    assert.equal(fuelChainReaches("W@0", "W@250", [], 300, dist), true);
  });
  it("still allows a single relay", () => {
    assert.equal(fuelChainReaches("W@0", "W@500", ["W@250"], 300, dist), true);
  });
  it("allows several relays: a ~660 leg with 300 tanks and stops every ~220", () => {
    const stops = ["W@220", "W@440"];
    assert.equal(fuelChainReaches("W@0", "W@660", stops, 300, dist), true);
  });
  it("is false when a gap between stops exceeds one tank", () => {
    assert.equal(fuelChainReaches("W@0", "W@660", ["W@220", "W@560"], 300, dist), false);
  });
  it("is false with no stops and a leg beyond one tank", () => {
    assert.equal(fuelChainReaches("W@0", "W@660", [], 300, dist), false);
  });
  it("ignores unknown distances (Infinity) rather than treating them as reachable", () => {
    assert.equal(fuelChainReaches("W@0", "W@660", ["W@x"], 300, (a, b) => (a.includes("x") || b.includes("x") ? Infinity : dist(a, b))), false);
  });
});
