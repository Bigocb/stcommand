import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactCredits, statusEvents } from "../src/engine/notify/status.js";
import { decide } from "../src/engine/notify/policy.js";
import { sanitizePrefs, effectivePrefs } from "../src/engine/notify/prefs.js";
import { EMPTY_STATE, type NotifySnapshot } from "../src/engine/notify/types.js";
import { detectAll } from "../src/engine/notify/detectors.js";

const HOUR = 3_600_000;
const snap = (now: number, over: Partial<NotifySnapshot> = {}): NotifySnapshot => ({
  now, approvals: [], stranded: [], attention: [],
  rate: { perHour1h: 7_361_000, perHour3h: 7_085_860 }, status: { ships: 335, credits: 307_604_862 }, ...over,
});

describe("status report", () => {
  it("writes the figures short", () => {
    assert.equal(compactCredits(7_361_000), "7.4M");
    assert.equal(compactCredits(950_400), "950k");
    assert.equal(compactCredits(-240_000), "-240k");
    const [e] = statusEvents(snap(100 * HOUR));
    assert.equal(e!.title, "Tower status");
    assert.equal(e!.body, "+7.4M/hr (3h avg 7.1M) · 335 ships · 307.6M credits · all clear");
    assert.equal(e!.severity, "info");
    assert.equal(e!.tag, "status");
    assert.equal(e!.slot, 100);
  });

  it("says what is waiting, and reports what it has when the rate is not known", () => {
    const [e] = statusEvents(snap(0, { rate: undefined, approvals: [{ id: "a", kind: "buyShip", shipSymbol: null }], stranded: [{ symbol: "S" }], idle: [{ symbol: "I", idleMs: 9 * 60_000 }] }));
    assert.equal(e!.body, "335 ships · 307.6M credits · 3 need you");
    assert.deepEqual(statusEvents({ now: 0, approvals: [], stranded: [], attention: [] }), [], "nothing to report");
  });

  it("is off until a device turns the category on, and then goes out once an hour, not again in the same hour", () => {
    const ev = (n: number) => detectAll(snap(n * HOUR + 5 * 60_000)).filter((e) => e.category === "status");
    assert.equal(decide(ev(100), EMPTY_STATE, effectivePrefs({}), 100 * HOUR).send.length, 0);
    const on = effectivePrefs({ categories: { status: true } });
    const first = decide(ev(100), EMPTY_STATE, on, 100 * HOUR + 5 * 60_000);
    assert.equal(first.send.length, 1);
    assert.equal(decide(ev(100), first.state, on, 100 * HOUR + 10 * 60_000).send.length, 0, "same hour");
    assert.equal(decide(ev(101), first.state, on, 101 * HOUR + 5 * 60_000).send.length, 1, "next hour");
  });

  it("a device that asked for every 3 hours gets only those hours", () => {
    const on = effectivePrefs({ categories: { status: true }, statusEveryHours: 3 });
    const sent = [99, 100, 101, 102].filter((n) => decide(statusEvents(snap(n * HOUR)), EMPTY_STATE, on, n * HOUR).send.length === 1);
    assert.deepEqual(sent, [99, 102]);
  });

  it("holds the report in quiet hours without losing the next one", () => {
    const quiet = effectivePrefs({ categories: { status: true }, quietHours: { startMin: 0, endMin: 1439, tzOffsetMin: 0, allowCritical: true } });
    const d = decide(statusEvents(snap(10 * HOUR)), EMPTY_STATE, quiet, 10 * HOUR);
    assert.equal(d.send.length, 0);
    assert.equal(d.held[0]!.reason, "quiet hours");
  });

  it("accepts only 1, 3, 6 or 12 hours", () => {
    assert.equal(sanitizePrefs({ statusEveryHours: 3 }).statusEveryHours, 3);
    assert.equal(sanitizePrefs({ statusEveryHours: 4 }).statusEveryHours, undefined);
    assert.equal(sanitizePrefs({ statusEveryHours: "6" }).statusEveryHours, 6);
    assert.equal(sanitizePrefs({ statusEveryHours: 99 }).statusEveryHours, undefined);
  });
});
