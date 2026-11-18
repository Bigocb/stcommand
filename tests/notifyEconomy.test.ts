import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAll, economyDetector } from "../src/engine/notify/detectors.js";
import { categoryOf } from "../src/engine/notify/categories.js";
import { decide } from "../src/engine/notify/policy.js";
import { DEFAULT_PREFS, EMPTY_STATE, type NotifySnapshot } from "../src/engine/notify/types.js";

/** The "Economy warning" push (category economy): the seam between the economy findings and the notification pass. */

const NOW = Date.parse("2026-11-18T02:53:00Z");
const snap = (economy: NotifySnapshot["economy"]): NotifySnapshot => ({ now: NOW, approvals: [], stranded: [], attention: [], economy });

describe("notify: economy category and detector", () => {
  it("the category is registered, on by default, with a 60 minute cooldown", () => {
    const c = categoryOf("economy");
    assert.ok(c);
    assert.equal(c.label, "Economy warning");
    assert.equal(c.defaultOn, true);
    assert.equal(c.cooldownMin, 60);
  });

  it("turns each finding into one event, per ship for smallHullJumping, with no credit figures", () => {
    const events = detectAll(snap([
      { id: "jumpsOverProfit", level: "bad" },
      { id: "smallHullJumping", level: "bad", ship: "THEO-1" },
    ]));
    const mine = events.filter((e) => e.category === "economy");
    assert.deepEqual(mine.map((e) => e.key), ["economy:jumpsOverProfit", "economy:smallHullJumping:THEO-1"]);
    for (const e of mine) {
      assert.equal(e.severity, "warning");
      assert.doesNotMatch(`${e.title} ${e.body}`, /\d+(\.\d+)?\s*[kKM]\b|\d{4,}|credits?\b|\bc\b/, "no credit figures in push text");
    }
    assert.match(mine[1]!.body, /THEO-1/);
  });

  it("no findings, no events", () => {
    assert.deepEqual(economyDetector.detect(snap(undefined)), []);
    assert.deepEqual(economyDetector.detect(snap([])), []);
  });

  it("goes out on a device that has not chosen, and repeats only after the hour", () => {
    const events = detectAll(snap([{ id: "netNegative", level: "bad" }])).filter((e) => e.category === "economy");
    const first = decide(events, EMPTY_STATE, DEFAULT_PREFS, NOW);
    assert.deepEqual(first.send.map((e) => e.key), ["economy:netNegative"]);
    const again = decide(events, first.state, DEFAULT_PREFS, NOW + 30 * 60_000);
    assert.deepEqual(again.send, [], "still within the 60 minute cooldown");
    const later = decide(events, first.state, DEFAULT_PREFS, NOW + 61 * 60_000);
    assert.deepEqual(later.send.map((e) => e.key), ["economy:netNegative"]);
  });
});
