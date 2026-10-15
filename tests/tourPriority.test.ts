import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TOUR_PRIORITY_POLICY, tourNextRunAt, tourTaskPriority } from "../src/engine/tourPriority.js";
import { DOCTRINE_CATALOG } from "../src/engine/doctrine.js";

const now = Date.parse("2026-10-15T01:20:00Z");
const idle = { hasTourDestination: false, inTransit: false };
const onTrip = { hasTourDestination: true, inTransit: false };
const flying = { hasTourDestination: true, inTransit: true, arrivalMs: now + 120_000 };

describe("tourTaskPriority", () => {
  it("boosts a tour with a trip under way, and keeps the base priority when idle", () => {
    assert.equal(tourTaskPriority(onTrip).priority, DEFAULT_TOUR_PRIORITY_POLICY.midTripPriority);
    assert.equal(tourTaskPriority(flying).priority, DEFAULT_TOUR_PRIORITY_POLICY.midTripPriority);
    assert.equal(tourTaskPriority(idle).priority, DEFAULT_TOUR_PRIORITY_POLICY.basePriority);
  });

  it("is exactly today's priority when the clause is off", () => {
    const off = { ...DEFAULT_TOUR_PRIORITY_POLICY, enabled: false };
    assert.equal(tourTaskPriority(flying, off).priority, 3);
  });
});

describe("tourNextRunAt", () => {
  it("waits for arrival when a ship is in transit", () => {
    assert.equal(tourNextRunAt(now, true, flying), now + 120_000);
  });

  it("keeps the old timing when the clause is off or no arrival is known", () => {
    const off = { ...DEFAULT_TOUR_PRIORITY_POLICY, enabled: false };
    assert.equal(tourNextRunAt(now, true, flying, off), now);
    assert.equal(tourNextRunAt(now, false, idle), now + 30_000);
    assert.equal(tourNextRunAt(now, true, idle), now);
  });

  it("never schedules into the past when the arrival has already passed", () => {
    assert.equal(tourNextRunAt(now, true, { inTransit: true, hasTourDestination: true, arrivalMs: now - 5_000 }), now);
  });
});

describe("tourHopPriority doctrine clause", () => {
  it("exists, is on by default, and is a plain toggle", () => {
    const rule = DOCTRINE_CATALOG.find((d) => d.key === "tourHopPriority");
    assert.ok(rule);
    assert.equal(rule!.enabled, true);
    assert.equal(rule!.defaultAdopted, true);
  });
});
