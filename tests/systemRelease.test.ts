import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SystemQueue } from "../src/engine/systemQueue.js";
import { DEFAULT_RELEASE_POLICY, aliveState, decideReleases, type LiveFacts, type QueueFacts, type ReleasePolicy, type ReleaseSignals } from "../src/engine/systemRelease.js";
import { RouteDispatcher } from "../src/engine/dispatcher.js";

const H = 3_600_000;
const MIN = 60_000;
const NOW = 100 * H;
const auto: ReleasePolicy = { ...DEFAULT_RELEASE_POLICY, mode: "auto" };

const staged = (system: string, readyShare: number, over: Partial<QueueFacts> = {}): QueueFacts => ({ system, state: "staged", held: false, addedAt: 1, stagedAt: 2, markets: 6, readyShare, ...over });
const scouted = (system: string, addedAt = 1, over: Partial<QueueFacts> = {}): QueueFacts => ({ system, state: "scouted", held: false, addedAt, markets: 6, ...over });
const live = (system: string, ageH: number, ratio: number | null = 1.7, sells = 40): LiveFacts => ({ system, releasedAt: NOW - ageH * H, ratio, sells });
const sig = (over: Partial<ReleaseSignals> = {}): ReleaseSignals => ({ now: NOW, queue: [], live: [], idleTraders: 0, budgetRoom: 100, ...over });

describe("system queue (pure)", () => {
  it("moves scouted -> staged -> live, gates everything not live, and a release clears the hold", () => {
    const q = new SystemQueue();
    q.scout("X1-A", ["X1-A-1", "X1-A-2"], 10);
    q.scout("X1-B", ["X1-B-1"], 20);
    assert.deepEqual([...q.gated()].sort(), ["X1-A", "X1-B"]);
    assert.equal(q.release("X1-NOPE", 30), false);
    assert.ok(q.stage("X1-A", 30));
    assert.equal(q.stage("X1-A", 31), false, "already staged");
    assert.ok(q.hold("X1-A", true));
    assert.ok(q.release("X1-A", 40, "operator"));
    assert.equal(q.get("X1-A")!.held, false, "a manual release clears the hold");
    assert.deepEqual([...q.gated()], ["X1-B"]);
    assert.equal(q.hold("X1-A", true), false, "a live system has no gate to hold");
    assert.equal(q.release("X1-A", 50), false, "already live");
  });

  it("keeps the first scouting and refreshes the market list only before it is live", () => {
    const q = new SystemQueue();
    q.scout("X1-A", ["X1-A-1"], 10);
    q.scout("X1-A", ["X1-A-1", "X1-A-9"], 99);
    assert.deepEqual([q.get("X1-A")!.markets, q.get("X1-A")!.addedAt], [["X1-A-1", "X1-A-9"], 10]);
    q.release("X1-A", 20);
    q.scout("X1-A", ["X1-A-5"], 99);
    assert.deepEqual(q.get("X1-A")!.markets, ["X1-A-1", "X1-A-9"]);
  });

  it("survives a save and a bad file", () => {
    const q = new SystemQueue();
    q.scout("X1-A", ["X1-A-1"], 10, "found");
    q.stage("X1-A", 20);
    q.hold("X1-A", true);
    const copy = new SystemQueue();
    assert.equal(copy.restore(q.toJson()), 1);
    assert.deepEqual(copy.get("X1-A"), q.get("X1-A"));
    assert.equal(copy.restore("nope"), 0);
    assert.equal(copy.restore('[{"system":"X1-Z","state":"weird","addedAt":1}]'), 0);
  });
});

describe("release rule", () => {
  it("is off in off mode, whatever the signals say", () => {
    const d = decideReleases(sig({ queue: [staged("X1-S", 1), scouted("X1-C")], idleTraders: 9 }), { ...DEFAULT_RELEASE_POLICY, mode: "off" });
    assert.deepEqual([d.stage, d.release, d.notes], [[], [], []]);
  });

  it("releases the best ready staged system when fewer than target live systems have a premium that is not fading", () => {
    const d = decideReleases(sig({ queue: [staged("X1-LOW", 0.9), staged("X1-FULL", 1)], live: [live("X1-L1", 1), live("X1-L2", 2)] }), auto);
    assert.deepEqual(d.release.map((r) => r.system), ["X1-FULL"]);
    assert.match(d.release[0]!.reason, /2 live premium system\(s\) not fading, target 3/);
  });

  it("does nothing when the target is met, and says so", () => {
    const d = decideReleases(sig({ queue: [staged("X1-S", 1)], live: [live("X1-L1", 1), live("X1-L2", 2), live("X1-L3", 3)] }), auto);
    assert.deepEqual(d.release, []);
    assert.match(d.notes.join(" "), /no release needed/);
  });

  it("opens the next one a lead time before the live ones fade", () => {
    // fade age 10h, lead 4h: a system at 6h or more is fading soon, so it stops counting and the next is wanted.
    const lives = [live("X1-L1", 1), live("X1-L2", 2), live("X1-L3", 6.5)];
    assert.equal(aliveState(lives[2]!, NOW, auto), "fading-soon");
    assert.deepEqual(decideReleases(sig({ queue: [staged("X1-S", 1)], live: lives }), auto).release.map((r) => r.system), ["X1-S"]);
    // a longer lead opens it earlier; a lead of 0 only at the fade age itself
    const early = { ...auto, leadMs: 9 * H };
    assert.equal(aliveState(live("X1-L1", 2), NOW, early), "fading-soon");
    assert.equal(aliveState(live("X1-L3", 6.5), NOW, { ...auto, leadMs: 0 }), "alive");
  });

  it("counts a system as faded when its recent ratio falls under the fade ratio, but not on a handful of sells", () => {
    assert.equal(aliveState(live("X1-L", 2, 1.1, 40), NOW, auto), "faded");
    assert.equal(aliveState(live("X1-L", 2, 1.1, 5), NOW, auto), "alive", "5 sells prove nothing");
    assert.equal(aliveState(live("X1-L", 2, null, 0), NOW, auto), "alive", "no ratio: age decides");
    assert.equal(aliveState(live("X1-L", 11, 1.7, 40), NOW, auto), "faded", "past the fade age");
  });

  it("counts only systems that trade once minTradingSells is on (off reproduces age-only counting)", () => {
    const lives = [live("X1-T1", 5, 1.7, 40), live("X1-U1", 5, null, 0), live("X1-U2", 5, null, 1), live("X1-N1", 1, null, 0)];
    const base: ReleasePolicy = { ...auto, target: 3 };
    const q = [staged("X1-S", 1)];
    assert.deepEqual(decideReleases(sig({ queue: q, live: lives }), base).release, [], "off: four alive systems, nothing to release");
    const on = decideReleases(sig({ queue: q, live: lives }), { ...base, minTradingSells: 3 });
    assert.deepEqual(on.release.map((r) => r.system), ["X1-S"], "on: only the trading one and the new one count");
    assert.match(on.release[0]!.reason, /2 not counted for lack of sales/);
    assert.equal(decideReleases(sig({ queue: q, live: [live("X1-N1", 1, null, 0), live("X1-N2", 2, null, 0), live("X1-N3", 2.5, null, 0)] }), { ...base, minTradingSells: 3 }).release.length, 0, "systems inside the grace window count");
  });

  it("releases at once for idle traders, ignoring the target and the gap, and never a held or unready system", () => {
    const lives = [live("X1-L1", 1), live("X1-L2", 2), live("X1-L3", 3)];
    const d = decideReleases(sig({ queue: [staged("X1-S", 1)], live: lives, idleTraders: 4, lastReleaseAt: NOW - 2 * MIN }), auto);
    assert.deepEqual(d.release.map((r) => r.system), ["X1-S"]);
    assert.match(d.release[0]!.reason, /4 trader\(s\) idle/);
    assert.deepEqual(decideReleases(sig({ queue: [staged("X1-S", 1, { held: true })], idleTraders: 4 }), auto).release, []);
    const unready = decideReleases(sig({ queue: [staged("X1-S", 0.5)], idleTraders: 4 }), auto);
    assert.deepEqual(unready.release, []);
    assert.match(unready.notes.join(" "), /no staged system is ready.*X1-S 50%/);
  });

  it("keeps a minimum gap between target-driven releases", () => {
    const d = decideReleases(sig({ queue: [staged("X1-S", 1)], lastReleaseAt: NOW - 10 * MIN }), auto);
    assert.deepEqual(d.release, []);
    assert.match(d.notes.join(" "), /last release was 10 min ago/);
  });

  it("stages the oldest unheld scouted system ahead of need, within the keeper budget", () => {
    const q = [scouted("X1-NEW", 5), scouted("X1-OLD", 1), scouted("X1-HELD", 0, { held: true })];
    assert.deepEqual(decideReleases(sig({ queue: q, live: [live("X1-L1", 1), live("X1-L2", 2), live("X1-L3", 3)] }), auto).stage.map((s) => s.system), ["X1-OLD"]);
    const tight = decideReleases(sig({ queue: q, budgetRoom: 3 }), auto);
    assert.deepEqual(tight.stage, []);
    assert.match(tight.notes.join(" "), /needs 6 keeper slot\(s\) and 3 are free/);
    assert.deepEqual(decideReleases(sig({ queue: [staged("X1-ALREADY", 1), ...q] }), auto).stage, [], "one is already staged ahead");
  });

  it("advisory returns the same answer as auto (the caller decides whether to act)", () => {
    const s = sig({ queue: [staged("X1-S", 1)], live: [live("X1-L1", 1)] });
    assert.deepEqual(decideReleases(s, { ...auto, mode: "advisory" }), decideReleases(s, auto));
  });

  it("never releases on missing information: nothing queued, nothing ready", () => {
    assert.deepEqual(decideReleases(sig(), auto).release, []);
    assert.deepEqual(decideReleases(sig({ queue: [staged("X1-S", undefined as unknown as number)] }), auto).release, []);
  });
});

describe("the gate at the dispatcher", () => {
  const route = (good: string, buyAt: string, buySystem: string, sellAt: string, sellSystem: string) => ({
    good, buyAt, buySystem, buyPrice: 2000, sellAt, sellSystem, sellPrice: 3000,
    volume: 100, lotSize: 40, distance: 10, fuelUnits: 10, fuelCost: 0, profitPerTrip: 60_000, ageMinutes: 5,
    profitByHold: { "100": 60_000 } as Record<string, number>,
  });
  const routes = [
    route("FOOD", "X1-A-1", "X1-A", "X1-A-2", "X1-A"),
    route("EQUIPMENT", "X1-A-1", "X1-A", "X1-NEW-1", "X1-NEW"),
    route("MACHINERY", "X1-NEW-2", "X1-NEW", "X1-A-2", "X1-A"),
  ];
  const run = (d: RouteDispatcher) => d.recompute(routes, [{ shipSymbol: "T1", capacity: 100 }], [], [], [], [], undefined, undefined, undefined, undefined, undefined, {});

  it("offers no route that buys or sells in a gated system, and all of them again once it opens", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const d = new RouteDispatcher();
    run(d);
    assert.equal(d.routeList().length, 3, "no gate: the list is exactly as before");
    d.setGatedSystems(new Set(["X1-NEW"]));
    t.mock.timers.tick(61_000); // recompute is throttled to once a minute
    run(d);
    assert.deepEqual(d.routeList().map((r) => r.good), ["FOOD"]);
    assert.deepEqual(d.gatedSystemList(), ["X1-NEW"]);
    d.setGatedSystems(new Set());
    t.mock.timers.tick(61_000);
    run(d);
    assert.equal(d.routeList().length, 3);
  });
});
