import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES } from "../src/engine/notify/categories.js";
import { needsYouCount } from "../src/engine/notify/badge.js";
import { DETECTORS, detectAll } from "../src/engine/notify/detectors.js";
import type { Detector, NotifySnapshot } from "../src/engine/notify/types.js";

const snap = (over: Partial<NotifySnapshot> = {}): NotifySnapshot => ({ now: 0, approvals: [], stranded: [], attention: [], ...over });

describe("notify detectors", () => {
  it("every detector's category is registered, and every category has a detector", () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const d of DETECTORS) assert.ok(ids.has(d.category), `${d.id} uses an unregistered category`);
    for (const c of CATEGORIES) assert.ok(DETECTORS.some((d) => d.category === c.id), `${c.id} has no detector`);
  });

  it("approvals: one event per approval, keyed by id, with no money in the text", () => {
    const e = detectAll(snap({ approvals: [{ id: "ap1", kind: "buyShip", shipSymbol: "THEOREM-1|X|hull" }, { id: "ap2", kind: "buyKeeperProbe", shipSymbol: null }] }));
    assert.deepEqual(e.map((x) => x.key), ["approval:ap1", "approval:ap2"]);
    assert.deepEqual([e[0]!.title, e[0]!.body], ["Ship purchase needs approval", "THEOREM-1"]);
    assert.deepEqual([e[1]!.title, e[1]!.body], ["Keeper probe purchase needs approval", "Open Tower to decide."]);
  });

  it("approvals: a sell below the loss floor names the ship and the good and says how long is left, with no figures", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    const [e] = detectAll(snap({ now, approvals: [{ id: "ap9", kind: "sellBelowFloor:THEOREM-5:LAB_INSTRUMENTS", shipSymbol: "THEOREM-5", expiresAt: "2026-10-24T00:30:00Z" }] }));
    assert.deepEqual([e!.title, e!.body, e!.category, e!.severity, e!.url], ["Sell below the loss floor?", "THEOREM-5 is holding lab instruments · 30 min to decide", "approvals", "warning", "/m#approvals"]);
    // no ship column: the ship comes from the kind's key; and an expired or unknown deadline says nothing about time
    const [f] = detectAll(snap({ now, approvals: [{ id: "ap10", kind: "sellBelowFloor:THEOREM-7:FOOD", shipSymbol: null, expiresAt: "2026-10-23T23:00:00Z" }] }));
    assert.equal(f!.body, "THEOREM-7 is holding food");
  });

  it("approvals: a kind with no wording of its own is still readable", () => {
    const [e] = detectAll(snap({ approvals: [{ id: "x", kind: "someNewThing_here", shipSymbol: "S-1|a|b" }] }));
    assert.deepEqual([e!.title, e!.body], ["Some new thing here: approval needed", "S-1"]);
  });

  it("stranded and attention: critical only for attention", () => {
    const e = detectAll(snap({
      stranded: [{ symbol: "THEOREM-9" }],
      attention: [
        { ship: "A", severity: "critical", reasons: [{ text: "same log line 20 times", severity: "critical" }] },
        { ship: "B", severity: "warning", reasons: [{ text: "low fuel", severity: "warning" }] },
      ],
    }));
    assert.deepEqual(e.map((x) => x.key), ["stranded:THEOREM-9", "attention:A"]);
    assert.equal(e[1]!.body, "same log line 20 times");
  });

  it("reset: a warning at two hours, a critical at fifteen minutes, nothing before or after", () => {
    const at = (ms?: number) => detectAll(snap({ msToReset: ms })).map((x) => `${x.key}/${x.severity}`);
    assert.deepEqual(at(3 * 3_600_000), []);
    assert.deepEqual(at(90 * 60_000), ["reset:2h/warning"]);
    assert.deepEqual(at(10 * 60_000), ["reset:15m/critical"]);
    assert.deepEqual(at(0), []);
    assert.deepEqual(at(undefined), []);
  });

  it("rate: only a real drop of a rate worth measuring, and it shows no figures", () => {
    // the status report also reads the rate; only the rate alert is under test here
    const at = (a: number, b: number) => detectAll(snap({ rate: { perHour1h: a, perHour3h: b } })).filter((e) => e.category === "rate");
    assert.equal(at(3_000_000, 8_000_000).length, 1);
    assert.doesNotMatch(JSON.stringify(at(3_000_000, 8_000_000)), /\d{4,}/);
    assert.equal(at(6_000_000, 8_000_000).length, 0);
    assert.equal(at(100, 400).length, 0, "a small rate is not worth an alert");
  });

  it("a detector that throws does not silence the others, and its events carry its own category", () => {
    const bad: Detector = { id: "bad", category: "approvals", detect: () => { throw new Error("boom"); } };
    const good: Detector = { id: "good", category: "stranded", detect: () => [{ key: "k", category: "wrong", severity: "info", title: "t", body: "b" }] };
    const e = detectAll(snap(), [bad, good]);
    assert.equal(e.length, 1);
    assert.equal(e[0]!.category, "stranded");
  });

  it("the icon badge counts approvals, stranded ships and critical attention flags", () => {
    assert.equal(needsYouCount(snap()), 0);
    assert.equal(needsYouCount(snap({
      approvals: [{ id: "a", kind: "buyShip", shipSymbol: null }, { id: "b", kind: "buyShip", shipSymbol: null }],
      stranded: [{ symbol: "S-1" }],
      attention: [
        { ship: "A", severity: "critical", reasons: [] },
        { ship: "B", severity: "warning", reasons: [] },
      ],
    })), 4);
  });
});
