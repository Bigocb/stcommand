import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configChangeEvent, keeperListChange, tripClosedEvent, tripId, tripPlannedEvent } from "../src/engine/actionEvents.js";
import { Doctrine } from "../src/engine/doctrine.js";

const plan = {
  shipSymbol: "THEOREM-55", good: "ADVANCED_CIRCUITRY", buyAt: "X1-A-1", sellAt: "X1-B-2",
  buyPrice: 4000, sellPrice: 6700, units: 490, profit: 1_100_000.4, tripCost: 11_000, lotSize: 100,
  buyVolume: 100, sellVolume: 100, source: "auto", maxLots: 6,
};

describe("trip events", () => {
  it("a planned trip carries the estimate it was chosen on, keyed by a correlation id", () => {
    const id = tripId(plan.shipSymbol, plan.good, 1000);
    const e = tripPlannedEvent(plan, id, "2026-10-15T00:00:00.000Z", { units: 490, avgPrice: 4100.6 });
    assert.equal(e.kind, "trip_planned");
    assert.equal(e.actor, "engine");
    assert.equal(e.correlationId, "trip:THEOREM-55:ADVANCED_CIRCUITRY:1000");
    assert.equal(e.subject, "X1-A-1>X1-B-2");
    assert.deepEqual(e.expected, { buyPrice: 4000, sellPrice: 6700, units: 490, profit: 1100000, tripCost: 11000, margin: 2700 });
    assert.deepEqual(e.observed, { unitsBought: 490, avgBuyPrice: 4101 });
    assert.equal((e.context as any).maxLots, 6);
  });

  it("a manual route is attributed to the operator", () => {
    assert.equal(tripPlannedEvent({ ...plan, source: "manual" }, "t", "2026-10-15T00:00:00.000Z", { units: 1, avgPrice: 1 }).actor, "operator");
  });

  it("a closed trip carries what it made and how long it took", () => {
    const start = Date.parse("2026-10-15T00:00:00Z");
    const e = tripClosedEvent({ shipSymbol: "S", good: "G", buyAt: "A", sellAt: "B", unitsSold: 80, revenue: 9600, cost: 8000, startedAtMs: start }, "t1", "2026-10-15T00:30:00.000Z", start + 30 * 60_000);
    assert.equal(e.kind, "trip_closed");
    assert.deepEqual(e.observed, { unitsSold: 80, revenue: 9600, cost: 8000, profit: 1600, avgSellPrice: 120, minutes: 30 });
    assert.equal(e.subject, "A>B");
    assert.match(e.reason!, /\+1600c/);
  });

  it("a trip that crossed a restart closes with no duration rather than a wrong one", () => {
    const e = tripClosedEvent({ shipSymbol: "S", good: "G", sellAt: "B", unitsSold: 10, revenue: 100, cost: 120 }, "t2", "2026-10-15T00:30:00.000Z", 0);
    assert.equal((e.observed as any).minutes, null);
    assert.equal((e.observed as any).profit, -20);
    assert.equal(e.subject, undefined);
  });
});

describe("config change events", () => {
  it("records before and after", () => {
    const e = configChangeEvent({ setting: "doctrine:maxLotsPerTrip", before: { value: 6 }, after: { value: 3 }, atIso: "2026-10-15T00:00:00.000Z" })!;
    assert.equal(e.kind, "config_change");
    assert.equal(e.subject, "doctrine:maxLotsPerTrip");
    assert.deepEqual(e.context, { before: { value: 6 }, after: { value: 3 } });
  });

  it("is null when nothing changed", () => {
    assert.equal(configChangeEvent({ setting: "x", before: { a: 1 }, after: { a: 1 }, atIso: "t" }), null);
  });

  it("summarises a keeper list change as added and removed markets", () => {
    assert.deepEqual(keeperListChange(["A", "B", "C"], ["A", "C", "D"]), { added: ["D"], removed: ["B"], count: 3 });
  });
});

describe("Doctrine.onChange", () => {
  it("fires with before and after when a rule actually changes, and not otherwise", async () => {
    const d = new Doctrine();
    const seen: unknown[] = [];
    d.onChange = (key, before, after) => seen.push({ key, before: before.value, after: after.value });
    await d.set("marginFloor", { value: 25 });
    await d.set("marginFloor", { value: 25 });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { key: "marginFloor", before: 10, after: 25 });
  });

  it("fires when only the enabled flag changes", async () => {
    const d = new Doctrine();
    let n = 0;
    d.onChange = () => { n += 1; };
    await d.set("tourHopPriority", { enabled: false });
    assert.equal(n, 1);
  });
});
