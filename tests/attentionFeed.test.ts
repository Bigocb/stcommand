import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AttentionFeed, digestOf } from "../src/engine/attentionFeed.js";
import type { ShipFacts } from "../src/engine/attention.js";
import { JudgeError, type Answer, type DecisionRow, type Judge, type JudgeRequest } from "../src/engine/judge.js";

const facts = (symbol: string, over: Partial<ShipFacts> = {}): ShipFacts => ({
  symbol, role: "tour", nav: "DOCKED", doing: "docked", held: false, restoredHold: false, stranded: false, fuelPercent: 99, cargoPercent: 0,
  cooldownSeconds: 0, secondsPastArrival: 0, minutesSinceLastLogLine: 0.1, mostRepeatedLogLine: null, timesRepeated: 0, repeatWindowMinutes: 10,
  waitingOnApproval: false, hasRouteAssigned: false, ...over,
});
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const reply = (over: Record<string, Answer> = {}) => ({ answers: { stuck: noul(0.1), looping: noul(0.1), unexpected_hold: noul(0.1), wasting: noul(0.1), next_step: { type: "choice", choice: "nothing", probabilities: { nothing: 0.9 }, confidence: 0.9 } as Answer, ...over }, model: "jev-test", inputTokens: 100, outputTokens: 10, latencyMs: 90 });

function rig(opts: { enabled?: boolean; judge?: Judge | null; ships?: ShipFacts[] } = {}) {
  let t = 1_000_000;
  const state = { ships: opts.ships ?? [facts("THEOREM-1", { held: true, restoredHold: true })], logs: [] as string[], rows: [] as DecisionRow[], pruned: 0 };
  const calls: JudgeRequest[] = [];
  const judge: Judge | undefined = opts.judge === null ? undefined : opts.judge ?? { decide: async (r) => { calls.push(r); return reply({ unexpected_hold: noul(0.95) }); } };
  const feed = new AttentionFeed({
    facts: () => state.ships, judge, policy: () => ({ enabled: opts.enabled ?? true, floor: 0.8 }), now: () => t,
    record: async (rows) => { state.rows.push(...rows); }, prune: async () => { state.pruned += 1; }, log: (m) => state.logs.push(m),
  });
  return { feed, state, calls, tick: (ms: number) => { t += ms; } };
}

describe("AttentionFeed", () => {
  it("does nothing while the clause is off: no facts read, no model call, an empty feed", async () => {
    const r = rig({ enabled: false });
    const snap = await r.feed.refresh();
    assert.equal(snap.enabled, false);
    assert.deepEqual(snap.items, []);
    assert.equal(r.calls.length, 0);
  });

  it("shows the rules' flags without any model", async () => {
    const r = rig({ judge: null });
    const snap = await r.feed.refresh();
    assert.equal(snap.modelConfigured, false);
    assert.equal(snap.items[0]!.ship, "THEOREM-1");
    assert.equal(snap.items[0]!.reasons[0]!.code, "restored_hold");
  });

  it("asks the model about a ship worth a second opinion, adds its flag, and logs every answer", async () => {
    const r = rig();
    const snap = await r.feed.refresh();
    assert.equal(r.calls.length, 1);
    assert.deepEqual(Object.keys(r.calls[0]!.state as object).slice(0, 2), ["ship", "role"]);
    assert.ok(snap.items[0]!.reasons.some((x) => x.by === "model" && x.code === "model_unexpected_hold"));
    assert.equal(r.state.rows.length, 5, "one row per question");
    assert.ok(r.state.rows.every((x) => x.feature === "attention" && x.acted === false), "the feed only advises");
  });

  it("does not ask about a healthy ship", async () => {
    const r = rig({ ships: [facts("OK-1")] });
    await r.feed.refresh();
    assert.equal(r.calls.length, 0);
  });

  it("reuses an answer while the ship looks the same, and asks again when it changes", async () => {
    const r = rig();
    await r.feed.refresh();
    r.tick(61_000);
    await r.feed.refresh();
    assert.equal(r.calls.length, 1, "same ship, same digest, fresh answer: not asked again");
    r.state.ships = [facts("THEOREM-1", { held: true, restoredHold: true, mostRepeatedLogLine: "x", timesRepeated: 30, minutesSinceLastLogLine: 0 })];
    r.tick(61_000);
    await r.feed.refresh();
    assert.equal(r.calls.length, 2, "the ship changed, so the question is asked again");
  });

  it("asks again once an answer has gone stale", async () => {
    const r = rig();
    await r.feed.refresh();
    r.tick(11 * 60_000);
    await r.feed.refresh();
    assert.equal(r.calls.length, 2);
  });

  it("is throttled: a second call inside the minimum interval changes nothing", async () => {
    const r = rig();
    await r.feed.refresh();
    r.tick(5_000);
    const before = r.feed.snapshot();
    assert.strictEqual(await r.feed.refresh(), before);
  });

  it("a failing model leaves the rules' feed intact and says so once", async () => {
    const r = rig({ judge: { decide: async () => { throw new JudgeError("decision model returned 529", 529, true); } } });
    const snap = await r.feed.refresh();
    assert.equal(snap.failed, 1);
    assert.equal(snap.items.length, 1, "the rules still flag the ship");
    assert.ok(snap.items[0]!.reasons.every((x) => x.by === "rule"));
    assert.equal(r.state.logs.filter((l) => /decision model unavailable/.test(l)).length, 1);
  });

  it("bounds how many ships are asked about in one pass", async () => {
    const ships = Array.from({ length: 20 }, (_, i) => facts(`S-${i}`, { held: true }));
    const r = rig({ ships });
    await r.feed.refresh();
    assert.equal(r.calls.length, 8);
  });

  it("goes quiet again when switched off, and forgets what it knew", async () => {
    let on = true;
    const r = rig();
    const feed = new AttentionFeed({ facts: () => r.state.ships, policy: () => ({ enabled: on, floor: 0.8 }), now: () => 5, judge: undefined });
    await feed.refresh();
    assert.equal(feed.snapshot().items.length, 1);
    on = false;
    assert.deepEqual((await feed.refresh()).items, []);
  });

  it("prunes the decision log about hourly", async () => {
    const r = rig();
    await r.feed.refresh();
    assert.equal(r.state.pruned, 1);
    r.tick(61_000);
    await r.feed.refresh();
    assert.equal(r.state.pruned, 1, "not again within the hour");
  });
});

describe("digestOf", () => {
  it("ignores small drift but notices a real change", () => {
    assert.equal(digestOf(facts("A", { minutesSinceLastLogLine: 1 })), digestOf(facts("A", { minutesSinceLastLogLine: 4 })));
    assert.notEqual(digestOf(facts("A", { minutesSinceLastLogLine: 1 })), digestOf(facts("A", { minutesSinceLastLogLine: 25 })));
    assert.notEqual(digestOf(facts("A")), digestOf(facts("A", { held: true })));
  });
});
