import { test } from "node:test";
import assert from "node:assert/strict";
import { TOUR_SENT_KEEP_MS, packFleetMemory, unpackFleetMemory } from "../src/engine/fleetMemory.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

test("tour send marks and yard prices paid round-trip", () => {
  const m = { tourSent: [["THEO-4", NOW - 60_000]] as [string, number][], yardPaid: [["X1-PD3-A20C|SHIP_PROBE", { price: 29_643, at: NOW - 600_000 }]] as [string, { price: number; at: number }][] };
  assert.deepEqual(unpackFleetMemory(packFleetMemory(m, NOW, HOUR), NOW, HOUR), m);
});

test("old rows, future rows and malformed rows are dropped; bad JSON is empty", () => {
  const json = JSON.stringify({
    tourSent: [["A", NOW - TOUR_SENT_KEEP_MS - 1], ["B", NOW + 1], ["C", "x"], ["D", NOW - 5]],
    yardPaid: [["Y|P", { price: 1, at: NOW - HOUR - 1 }], ["Z|P", { price: 0, at: NOW }], ["W|P", { price: 5, at: NOW - 5 }]],
  });
  const m = unpackFleetMemory(json, NOW, HOUR);
  assert.deepEqual(m.tourSent.map(([s]) => s), ["D"]);
  assert.deepEqual(m.yardPaid.map(([k]) => k), ["W|P"]);
  assert.deepEqual(unpackFleetMemory("nope", NOW, HOUR), { tourSent: [], yardPaid: [] });
});
