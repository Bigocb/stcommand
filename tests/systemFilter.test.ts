import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { waypointSystem, approvalSystem, filterBySystem, systemCounts, systemChipsHtml } from "../public/shared/systemFilter.js";

test("waypointSystem", () => {
  assert.equal(waypointSystem("X1-SN86-K83"), "X1-SN86");
  assert.equal(waypointSystem("THEO-1"), null);
  assert.equal(waypointSystem(undefined), null);
});

test("approvalSystem reads the market part of a keeper card", () => {
  assert.equal(approvalSystem({ shipSymbol: "X1-SN86-C38|X1-SN86-K83|SHIP_PROBE" }), "X1-SN86");
  assert.equal(approvalSystem({ shipSymbol: "X1-BB74-H66|X1-B64-F62|SHIP_SURVEYOR" }), "X1-B64");
  assert.equal(approvalSystem({ shipSymbol: "THEO-1" }), null);
});

test("filter keeps the chosen system and always keeps items with no system", () => {
  const items = ["X1-SN86-A", "X1-B64-A", "THEO-1"];
  assert.deepEqual(filterBySystem(items, "X1-B64", waypointSystem), ["X1-B64-A", "THEO-1"]);
  assert.deepEqual(filterBySystem(items, "all", waypointSystem), items);
  assert.deepEqual(filterBySystem(items, "", waypointSystem), items);
});

test("counts are most first and chips show All with the total", () => {
  const c = systemCounts(["X1-B64", "X1-SN86", "X1-SN86", null]);
  assert.deepEqual(c, [{ system: "X1-SN86", count: 2 }, { system: "X1-B64", count: 1 }]);
  const html = systemChipsHtml(c, "X1-B64", (s: string) => String(s));
  assert.match(html, /data-sys="all">All <b>3<\/b>/);
  assert.match(html, /sys-chip on" data-sys="X1-B64">B64 <b>1<\/b>/);
});
