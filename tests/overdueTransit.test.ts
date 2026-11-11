import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOverdueTransit } from "../src/engine/overdueTransit.js";

const NOW = Date.parse("2026-11-10T03:00:00Z");
const nav = (status: string, arrival?: string) => ({ status, route: arrival ? { arrival } : null });

describe("isOverdueTransit", () => {
  it("an in-transit ship past its arrival (beyond grace) is overdue", () => {
    assert.equal(isOverdueTransit(nav("IN_TRANSIT", "2026-11-10T02:55:00Z"), NOW, 120_000), true);
  });

  it("inside the grace window is not overdue: the ship's own wake-up is about to run", () => {
    assert.equal(isOverdueTransit(nav("IN_TRANSIT", "2026-11-10T02:59:30Z"), NOW, 120_000), false);
  });

  it("an arrival in the future is not overdue", () => {
    assert.equal(isOverdueTransit(nav("IN_TRANSIT", "2026-11-10T03:10:00Z"), NOW, 120_000), false);
  });

  it("a docked or orbiting ship is never overdue, whatever its old route says", () => {
    assert.equal(isOverdueTransit(nav("DOCKED", "2026-11-01T00:00:00Z"), NOW, 120_000), false);
    assert.equal(isOverdueTransit(nav("IN_ORBIT", "2026-11-01T00:00:00Z"), NOW, 120_000), false);
  });

  it("a missing or unparseable arrival is not overdue (nothing to compare, no wasted reads)", () => {
    assert.equal(isOverdueTransit(nav("IN_TRANSIT"), NOW, 120_000), false);
    assert.equal(isOverdueTransit({ status: "IN_TRANSIT", route: { arrival: "not-a-date" } }, NOW, 120_000), false);
    assert.equal(isOverdueTransit(undefined, NOW, 120_000), false);
    assert.equal(isOverdueTransit(null, NOW, 120_000), false);
  });
});
