import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categoryEnabled, decide, inQuietHours } from "../src/engine/notify/policy.js";
import { DEFAULT_PREFS, EMPTY_STATE, type NotifyEvent, type NotifyPrefs } from "../src/engine/notify/types.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-24T12:00:00Z");
const ev = (key: string, category = "approvals", severity: NotifyEvent["severity"] = "warning"): NotifyEvent => ({ key, category, severity, title: `t ${key}`, body: `b ${key}` });
const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({ ...DEFAULT_PREFS, ...over });

describe("notify policy: switches", () => {
  it("sends an enabled category, uses the category default when the device has not chosen, and respects the master switch", () => {
    assert.equal(decide([ev("a")], EMPTY_STATE, prefs(), T0).send.length, 1);
    assert.equal(categoryEnabled(prefs(), "rate"), false, "rate is off by default");
    assert.equal(decide([ev("r", "rate")], EMPTY_STATE, prefs(), T0).send.length, 0);
    assert.equal(decide([ev("r", "rate")], EMPTY_STATE, prefs({ categories: { rate: true } }), T0).send.length, 1);
    assert.equal(decide([ev("a")], EMPTY_STATE, prefs({ categories: { approvals: false } }), T0).send.length, 0);
    const off = decide([ev("a")], EMPTY_STATE, prefs({ enabled: false }), T0);
    assert.equal(off.send.length, 0);
    assert.equal(off.held[0]!.reason, "notifications are off");
  });
});

describe("notify policy: dedupe", () => {
  it("does not repeat a condition that is still true, and says it again after it clears and returns", () => {
    const first = decide([ev("a")], EMPTY_STATE, prefs(), T0);
    assert.equal(first.send.length, 1);
    const again = decide([ev("a")], first.state, prefs(), T0 + 10 * MIN);
    assert.equal(again.send.length, 0);
    assert.equal(again.held[0]!.reason, "already announced");
    const cleared = decide([], again.state, prefs(), T0 + 20 * MIN);
    assert.deepEqual(cleared.state.sent, {}, "a cleared condition is forgotten");
    assert.equal(decide([ev("a")], cleared.state, prefs(), T0 + 30 * MIN).send.length, 1);
  });

  it("repeats a standing condition after its category's cooldown (stranded: 120 minutes)", () => {
    const s = ev("stranded:X", "stranded", "critical");
    const first = decide([s], EMPTY_STATE, prefs(), T0);
    assert.equal(decide([s], first.state, prefs(), T0 + 119 * MIN).send.length, 0);
    assert.equal(decide([s], first.state, prefs(), T0 + 121 * MIN).send.length, 1);
  });
});

describe("notify policy: quiet hours", () => {
  const q = { startMin: 22 * 60, endMin: 7 * 60, tzOffsetMin: -300, allowCritical: true }; // 22:00-07:00 at UTC-5
  it("knows when it is quiet, across midnight and with an offset", () => {
    assert.equal(inQuietHours(Date.parse("2026-10-24T05:00:00Z"), q), true, "00:00 local");
    assert.equal(inQuietHours(Date.parse("2026-10-24T11:59:00Z"), q), true, "06:59 local");
    assert.equal(inQuietHours(Date.parse("2026-10-24T12:00:00Z"), q), false, "07:00 local");
    assert.equal(inQuietHours(Date.parse("2026-10-24T20:00:00Z"), q), false, "15:00 local");
    assert.equal(inQuietHours(Date.parse("2026-10-25T03:00:00Z"), q), true, "22:00 local");
    assert.equal(inQuietHours(T0, { ...q, startMin: 600, endMin: 600 }), false, "an empty window is never quiet");
  });

  it("holds all but critical during quiet hours, releases the held ones afterwards, and can hold critical too", () => {
    const night = Date.parse("2026-10-24T06:00:00Z"); // 01:00 local
    const events = [ev("a", "approvals", "warning"), ev("s", "reset", "critical")]; // reset repeats never (cooldown 0)
    const d = decide(events, EMPTY_STATE, prefs({ quietHours: q }), night);
    assert.deepEqual(d.send.map((e) => e.key), ["s"]);
    assert.deepEqual(d.held, [{ key: "a", reason: "quiet hours" }]);
    const morning = decide(events, d.state, prefs({ quietHours: q }), Date.parse("2026-10-24T12:30:00Z"));
    assert.deepEqual(morning.send.map((e) => e.key), ["a"], "the held one goes out once it is morning; the critical one is not repeated");
    const strict = decide(events, EMPTY_STATE, prefs({ quietHours: { ...q, allowCritical: false } }), night);
    assert.equal(strict.send.length, 0);
  });
});

describe("notify policy: hourly cap and digests", () => {
  it("sends at most maxPerHour, most severe first, and the rest go when the hour has room", () => {
    const events = [ev("w1", "attention", "warning"), ev("c1", "stranded", "critical"), ev("w2", "approvals", "warning")];
    const d = decide(events, EMPTY_STATE, prefs({ maxPerHour: 2 }), T0);
    assert.deepEqual(d.send.map((e) => e.key), ["c1", "w1"]);
    assert.deepEqual(d.held, [{ key: "w2", reason: "hourly limit" }]);
    const later = decide(events, d.state, prefs({ maxPerHour: 2 }), T0 + 61 * MIN);
    assert.deepEqual(later.send.map((e) => e.key), ["w2"], "the held one is sent once the hour has passed");
  });

  it("folds three or more of one category into one digest message and records each member as sent", () => {
    const events = [ev("a1"), ev("a2"), ev("a3"), ev("a4")];
    const d = decide(events, EMPTY_STATE, prefs(), T0);
    assert.equal(d.send.length, 1);
    assert.equal(d.send[0]!.title, "4 alerts: Approvals waiting");
    assert.match(d.send[0]!.body, /\+1 more/);
    assert.deepEqual(Object.keys(d.state.sent).sort(), ["a1", "a2", "a3", "a4"]);
    assert.equal(decide(events, d.state, prefs(), T0 + MIN).send.length, 0);
    assert.equal(decide([ev("a1"), ev("a2")], EMPTY_STATE, prefs(), T0).send.length, 2, "two stay separate");
  });
});

describe("notify policy: seeding", () => {
  it("records standing conditions without sending, so a restart does not announce them again", () => {
    const seeded = decide([ev("a"), ev("b")], EMPTY_STATE, prefs(), T0, { seedOnly: true });
    assert.equal(seeded.send.length, 0);
    assert.deepEqual(Object.keys(seeded.state.sent).sort(), ["a", "b"]);
    const next = decide([ev("a"), ev("b"), ev("c")], seeded.state, prefs(), T0 + MIN);
    assert.deepEqual(next.send.map((e) => e.key), ["c"], "only what is new is sent");
  });
});
