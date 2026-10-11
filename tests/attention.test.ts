import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assess, buildAttention, ruleReasons, shipQuestions, shipState, worthAsking, type ShipFacts } from "../src/engine/attention.js";
import type { Answer } from "../src/engine/judge.js";

const facts = (over: Partial<ShipFacts> = {}): ShipFacts => ({
  symbol: "THEOREM-1", role: "tour", nav: "DOCKED", doing: "docked", held: false, restoredHold: false, stranded: false,
  fuelPercent: 99, cargoPercent: 0, cooldownSeconds: 0, secondsPastArrival: 0, minutesSinceLastLogLine: 0.1,
  mostRepeatedLogLine: null, timesRepeated: 0, repeatWindowMinutes: 10, waitingOnApproval: false, hasRouteAssigned: false, ...over,
});
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, confidence: number): Answer => ({ type: "choice", choice: c, probabilities: { [c]: confidence }, confidence });
const policy = { floor: 0.8 };

describe("ruleReasons: this week's incidents", () => {
  it("flags the stale hold replayed at boot, and the approval wait beside it", () => {
    // THEOREM-1, 2026-10-11: held at A2 by a saved hold, logging the approval line every 1.5 s.
    const r = ruleReasons(facts({ held: true, restoredHold: true, wantsReason: "held at X1-CM13-A2 by the operator", mostRepeatedLogLine: "tour scout: holding at X1-CM13-A2 — keeper probe approval pending", timesRepeated: 30, waitingOnApproval: true }));
    assert.deepEqual(r.map((x) => x.code), ["restored_hold", "waiting_approval"]);
    assert.match(r[0]!.text, /saved hold replayed when the server booted/);
    assert.equal(r[1]!.severity, "info", "an approval wait is normal, the stale hold is the finding");
  });

  it("flags a ship repeating one line without progress", () => {
    const r = ruleReasons(facts({ role: "trader", symbol: "THEO-62", mostRepeatedLogLine: "dispatch: THEO-62 idle got nothing", timesRepeated: 15 }));
    assert.ok(r.some((x) => x.code === "retry_loop" && x.severity === "warning"));
    assert.match(r.find((x) => x.code === "retry_loop")!.text, /repeating "dispatch: THEO-62 idle got nothing" 15 times in 10 min/);
  });

  it("does not call a long transit a loop, or a healthy docked ship anything at all", () => {
    assert.deepEqual(ruleReasons(facts({ nav: "IN_TRANSIT", mostRepeatedLogLine: "navigating", timesRepeated: 40 })), []);
    assert.deepEqual(ruleReasons(facts()), []);
  });

  it("flags stranded as critical, overdue transit, low fuel and a long silence", () => {
    assert.equal(ruleReasons(facts({ stranded: true }))[0]!.severity, "critical");
    assert.ok(ruleReasons(facts({ nav: "IN_TRANSIT", secondsPastArrival: 900 })).some((x) => x.code === "transit_overdue"));
    assert.ok(ruleReasons(facts({ nav: "IN_ORBIT", fuelPercent: 8 })).some((x) => x.code === "low_fuel"));
    assert.ok(ruleReasons(facts({ minutesSinceLastLogLine: 45 })).some((x) => x.code === "quiet"));
  });

  it("a plain operator hold is information, not a warning", () => {
    const r = ruleReasons(facts({ held: true, wantsReason: "held at X by the operator" }));
    assert.deepEqual(r.map((x) => [x.code, x.severity]), [["held", "info"]]);
  });

  it("a keeper probe (no tank) is never flagged for fuel", () => {
    assert.deepEqual(ruleReasons(facts({ role: "keeper", fuelPercent: null })), []);
  });
});

describe("assess: the model's voice", () => {
  const answers = (over: Record<string, Answer>): Record<string, Answer> => ({ stuck: noul(0.1), looping: noul(0.1), unexpected_hold: noul(0.1), wasting: noul(0.1), next_step: choice("nothing", 0.9), ...over });

  it("adds a flag only at or above the floor, and labels it as the model's", () => {
    assert.equal(assess(facts(), answers({ stuck: noul(0.79) }), policy), undefined, "just below the floor: nothing");
    const item = assess(facts(), answers({ stuck: noul(0.92) }), policy)!;
    assert.equal(item.reasons[0]!.by, "model");
    assert.match(item.reasons[0]!.text, /model: looks stuck \(92% sure\)/);
    assert.equal(item.model?.stuck, 0.92);
  });

  it("keeps the rules' flag and adds the model's beside it", () => {
    const item = assess(facts({ held: true, restoredHold: true }), answers({ unexpected_hold: noul(0.97) }), policy)!;
    assert.deepEqual(item.reasons.map((r) => r.by), ["rule", "model"]);
    assert.equal(item.severity, "warning");
  });

  it("suggests a next step only when sure and it is an action", () => {
    assert.equal(assess(facts({ held: true }), answers({ next_step: choice("release_hold", 0.9) }), policy)!.suggestion, "release its hold (90% sure)");
    assert.equal(assess(facts({ held: true }), answers({ next_step: choice("release_hold", 0.5) }), policy)!.suggestion, undefined, "below the floor");
    assert.equal(assess(facts({ held: true }), answers({ next_step: choice("wait", 0.99) }), policy)!.suggestion, undefined, "'wait' is not a step to show");
  });

  it("works without the model: rules alone", () => {
    assert.equal(assess(facts({ stranded: true }), undefined, policy)!.severity, "critical");
  });
});

describe("buildAttention", () => {
  it("lists the most urgent first, then by how many reasons, then by name", () => {
    const list = buildAttention([
      facts({ symbol: "B", held: true }),
      facts({ symbol: "A", held: true }),
      facts({ symbol: "C", stranded: true }),
      facts({ symbol: "D", held: true, restoredHold: true }),
      facts({ symbol: "E" }),
    ], new Map(), policy);
    assert.deepEqual(list.map((i) => i.ship), ["C", "D", "A", "B"]);
  });
});

describe("what is sent", () => {
  it("shipState has only the labelled, allow-listed fields, so nothing extra can travel", () => {
    const leaky = { ...facts(), token: "sctk_secret", agentCredits: 596829, internalNote: "x" } as unknown as ShipFacts;
    const s = shipState(leaky);
    assert.ok(!("token" in s) && !("agentCredits" in s) && !("internalNote" in s));
    assert.equal(s.ship, "THEOREM-1");
    assert.equal(s.holdWasRestoredAtBoot, false);
  });

  it("puts 'nothing' first among the next steps, and asks only literal yes/no questions otherwise", () => {
    const q = shipQuestions();
    assert.equal(Object.keys((q.next_step as { criteria: Record<string, unknown> }).criteria)[0], "nothing");
    for (const k of ["stuck", "looping", "unexpected_hold", "wasting"]) assert.equal(q[k]?.type, "noul");
  });

  it("only ships with something worth a second opinion are asked about", () => {
    assert.equal(worthAsking(facts()), false);
    assert.equal(worthAsking(facts({ held: true })), true);
    assert.equal(worthAsking(facts({ stranded: true })), true);
    assert.equal(worthAsking(facts({ mostRepeatedLogLine: "x", timesRepeated: 8 })), true);
  });
});
