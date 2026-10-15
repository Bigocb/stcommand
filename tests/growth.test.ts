import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { growthPerWeek, hullCapitalAt, netWorthSeries } from "../src/engine/growth.js";

const H = 3_600_000;
const T0 = Date.parse("2026-10-14T00:00:00Z");
const at = (h: number) => T0 + h * H;

describe("hull capital", () => {
  it("a purchase moves cash into capital, so net worth is unchanged by buying a hull", () => {
    // 1,000,000 cash, then a 100,000 hull bought: cash drops to 900,000, capital rises to 100,000.
    const samples = [{ ts: at(0), worth: 1_000_000 }, { ts: at(1), worth: 900_000 }];
    const events = [{ ts: at(0.5), amount: 100_000 }];
    assert.deepEqual(netWorthSeries(samples, events).map((p) => p.netWorth), [1_000_000, 1_000_000]);
  });

  it("scrap proceeds come back out of capital, so scrapping a hull doesn't read as growth", () => {
    const events = [{ ts: at(0), amount: 100_000 }, { ts: at(2), amount: -40_000 }];
    assert.equal(hullCapitalAt(events, at(1)), 100_000);
    assert.equal(hullCapitalAt(events, at(3)), 60_000);
  });
});

describe("growth per week", () => {
  it("is the change over the samples' own span, scaled to a week", () => {
    // 1,000,000 -> 1,030,000 over 12 hours: +3% in half a day, so +6% a day.
    const samples = [{ ts: at(0), worth: 1_000_000 }, { ts: at(6), worth: 1_015_000 }, { ts: at(12), worth: 1_030_000 }];
    const g = growthPerWeek(samples, [], at(0), at(12));
    assert.ok(g);
    assert.equal(g.perWeekPct, 42);
    assert.equal(g.hours, 12);
  });

  it("counts a hull purchase as capital, not a loss", () => {
    const samples = [{ ts: at(0), worth: 1_000_000 }, { ts: at(12), worth: 930_000 }];
    const events = [{ ts: at(6), amount: 100_000 }];
    const g = growthPerWeek(samples, events, at(0), at(12));
    assert.ok(g);
    assert.equal(g.startNetWorth, 1_000_000);
    assert.equal(g.endNetWorth, 1_030_000, "930k cash plus a 100k hull");
    assert.equal(g.perWeekPct, 42);
  });

  it("is null without two samples, a short span, or a zero starting net worth", () => {
    assert.equal(growthPerWeek([{ ts: at(0), worth: 1_000 }], [], at(0), at(1)), null);
    assert.equal(growthPerWeek([{ ts: at(0), worth: 1_000 }, { ts: at(0.2), worth: 1_100 }], [], at(0), at(1)), null);
    assert.equal(growthPerWeek([{ ts: at(0), worth: 0 }, { ts: at(2), worth: 100 }], [], at(0), at(3)), null);
  });

  it("ignores samples outside the window", () => {
    const samples = [{ ts: at(-5), worth: 1 }, { ts: at(0), worth: 1_000_000 }, { ts: at(24), worth: 1_010_000 }, { ts: at(40), worth: 9_000_000 }];
    const g = growthPerWeek(samples, [], at(0), at(24));
    assert.ok(g);
    assert.equal(g.perWeekPct, 7);
  });
});
