import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES } from "../src/engine/notify/categories.js";
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
    const e = detectAll(snap({ approvals: [{ id: "ap1", kind: "buy_ship", shipSymbol: "THEOREM-1|X|hull" }, { id: "ap2", kind: "keeper_probe", shipSymbol: null }] }));
    assert.deepEqual(e.map((x) => x.key), ["approval:ap1", "approval:ap2"]);
    assert.equal(e[0]!.body, "buy ship · THEOREM-1");
    assert.equal(e[1]!.body, "keeper probe");
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
    const at = (a: number, b: number) => detectAll(snap({ rate: { perHour1h: a, perHour3h: b } }));
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
});
