import { test } from "node:test";
import assert from "node:assert/strict";
import { rotateBySystem, systemOf, rotationReason } from "../src/engine/keeperRotation.js";

const list = ["X1-SN86-A", "X1-SN86-B", "X1-SN86-C", "X1-B64-A", "X1-AH21-A", "X1-AH21-B"];

test("systemOf strips the last segment", () => {
  assert.equal(systemOf("X1-SN86-K83"), "X1-SN86");
  assert.equal(systemOf("X1"), "X1");
});

test("disabled reproduces the input", () => {
  assert.deepEqual(rotateBySystem(list, new Map([["X1-SN86", 5]]), { enabled: false }), list);
});

test("never-served systems keep the incoming order", () => {
  assert.deepEqual(rotateBySystem(list, new Map(), { enabled: true }), list);
});

test("the system just served goes to the back and its own order is kept", () => {
  const out = rotateBySystem(list, new Map([["X1-SN86", 1000]]), { enabled: true });
  assert.deepEqual(out, ["X1-B64-A", "X1-AH21-A", "X1-AH21-B", "X1-SN86-A", "X1-SN86-B", "X1-SN86-C"]);
});

test("least recently served first, ties by incoming order", () => {
  const out = rotateBySystem(list, new Map([["X1-SN86", 3000], ["X1-B64", 1000], ["X1-AH21", 2000]]), { enabled: true });
  assert.deepEqual(out.map(systemOf).filter((s, i, a) => a.indexOf(s) === i), ["X1-B64", "X1-AH21", "X1-SN86"]);
  assert.deepEqual(rotateBySystem(list, new Map([["X1-SN86", 1], ["X1-B64", 1], ["X1-AH21", 1]]), { enabled: true }), list);
});

test("rotation reason names the system", () => {
  assert.match(rotationReason("X1-B64-A", new Map(), 0), /has not had/);
  assert.match(rotationReason("X1-B64-A", new Map([["X1-B64", 0]]), 120_000), /2 min ago/);
});
