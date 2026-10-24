import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GATE_POLICY, gateAtOrBefore, gateBuildTime, gateSampleChanged, gatesDue, planScan, systemOfHq, type GateKnown, type PublicAgent } from "../src/engine/agentWatch.js";

const MIN = 60_000;
const H = 3_600_000;
const NOW = 1_000 * H;
const agent = (symbol: string, hq: string, over: Partial<PublicAgent> = {}): PublicAgent => ({ symbol, headquarters: hq, credits: 175_000, startingFaction: "COSMIC", shipCount: 2, ...over });

describe("planScan", () => {
  const list = [agent("A", "X1-VP49-A1"), agent("B", "X1-VP49-A1"), agent("C", "X1-NB29-A1", { startingFaction: "AEGIS" })];

  it("calls every agent a baseline sighting on the first scan of a reset, with no bracket", () => {
    const p = planScan(new Map(), list, NOW, undefined);
    assert.deepEqual(p.inserts.map((s) => [s.agent, s.source, s.priorScanAt]), [["A", "baseline", undefined], ["B", "baseline", undefined], ["C", "baseline", undefined]]);
    assert.deepEqual(p.touches, []);
  });

  it("brackets a new agent between the previous scan and this one, and counts who shared its start", () => {
    const known = new Map([["A", { lastSeenAt: NOW - 15 * MIN }], ["C", { lastSeenAt: NOW - 15 * MIN }]]);
    const p = planScan(known, list, NOW, NOW - 15 * MIN);
    assert.equal(p.inserts.length, 1);
    const b = p.inserts[0]!;
    assert.deepEqual([b.agent, b.source, b.priorScanAt, b.firstSeenAt, b.agentsInSystem, b.system, b.faction], ["B", "live", NOW - 15 * MIN, NOW, 2, "X1-VP49", "COSMIC"]);
    assert.deepEqual(p.touches.map((t) => t.agent), ["A", "C"], "agents already known are refreshed, not re-recorded");
    assert.equal(p.touches[1]!.hq, "X1-NB29-A1");
  });

  it("reports an agent missing from a scan but never deletes it", () => {
    const known = new Map([["A", { lastSeenAt: 1 }], ["GONE", { lastSeenAt: 1 }]]);
    assert.deepEqual(planScan(known, [agent("A", "X1-VP49-A1")], NOW, 1).missing, ["GONE"]);
  });

  it("systemOfHq", () => assert.equal(systemOfHq("X1-VP49-A1"), "X1-VP49"));
});

describe("gatesDue", () => {
  const gateOf = new Map([["X1-A", "X1-A-G"], ["X1-B", "X1-B-G"], ["X1-C", "X1-C-G"], ["X1-D", "X1-D-G"]]);
  const last = new Map<string, GateKnown>([
    ["X1-B-G", { sampledAt: NOW - 10 * MIN, complete: false }], // read recently
    ["X1-C-G", { sampledAt: NOW - 2 * H, complete: false }], // stale
    ["X1-D-G", { sampledAt: NOW - 9 * H, complete: true }], // final
  ]);

  it("reads a never-sampled gate first, then stale unfinished ones oldest first, and never a finished one", () => {
    const due = gatesDue(["X1-A", "X1-B", "X1-C", "X1-D"], last, gateOf, NOW);
    assert.deepEqual(due.map((d) => d.system), ["X1-A", "X1-C"]);
  });

  it("reads a system a new agent just appeared in at once unless its gate is finished", () => {
    const due = gatesDue(["X1-B", "X1-D"], last, gateOf, NOW, DEFAULT_GATE_POLICY, new Set(["X1-B", "X1-D"]));
    assert.deepEqual(due.map((d) => d.system), ["X1-B"]);
  });

  it("asks for a gate symbol it does not know, and caps one scan's reads", () => {
    assert.deepEqual(gatesDue(["X1-NEW"], new Map(), gateOf, NOW), [{ system: "X1-NEW", gate: undefined }]);
    const many = Array.from({ length: 100 }, (_, i) => `X1-S${i}`);
    assert.equal(gatesDue(many, new Map(), new Map(), NOW, { recheckMs: 30 * MIN, maxPerScan: 60 }).length, 60);
  });
});

describe("gate timeline helpers", () => {
  const s = (hoursIn: number, fulfilled: number, complete = false) => ({ sampledAt: hoursIn * H, fulfilled, required: 2001, complete });
  const timeline = [s(0, 1), s(5, 400), s(30, 1900), s(32, 2001, true)];

  it("a reading is worth a row only when what was supplied or the finished flag changed", () => {
    assert.equal(gateSampleChanged(undefined, { fulfilled: 1, complete: false }), true);
    assert.equal(gateSampleChanged({ fulfilled: 1, complete: false }, { fulfilled: 1, complete: false }), false);
    assert.equal(gateSampleChanged({ fulfilled: 1, complete: false }, { fulfilled: 5, complete: false }), true);
    assert.equal(gateSampleChanged({ fulfilled: 2001, complete: false }, { fulfilled: 2001, complete: true }), true);
  });

  it("finds the gate as it stood at a moment, and how long it took to finish", () => {
    assert.equal(gateAtOrBefore(timeline, 6 * H)!.fulfilled, 400);
    assert.equal(gateAtOrBefore(timeline, 0)!.fulfilled, 1);
    assert.equal(gateAtOrBefore(timeline, -1), undefined, "before the first sample there is no answer");
    assert.deepEqual(gateBuildTime(timeline), { firstAt: 0, completedAt: 32 * H, hours: 32 });
    assert.equal(gateBuildTime(timeline.slice(0, 3)), undefined, "unfinished: no build time");
  });
});
