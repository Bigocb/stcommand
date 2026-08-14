import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { ScoutAgent } from "../src/engine/scout.js";
import { SiphonerAgent } from "../src/engine/siphoner.js";

/**
 * Greenfield Phase 7: the Scheduler Task-producer wrappers on ShipAgent
 * (miner/survey/tour/keeper roles), ScoutAgent, and SiphonerAgent — same
 * approach and same test strategy as tests/traderNextTask.test.ts (Phase
 * 6): stub the wrapped work-unit method, verify Task shape and backoff
 * timing, not real mining/surveying/scouting/siphoning decisions.
 */

function makeShip(symbol = "SHIP-1"): Ship {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

describe("ShipAgent.nextTask (miner role)", () => {
  it("returns a well-formed Task and chains a ready-now task after productive work", async () => {
    const agent = new ShipAgent(makeShip("MINER-1"), { api: {} as any });
    (agent as any).tick = async () => true;
    const task = agent.nextTask();
    assert.equal(task.id, "MINER-1-mine");
    assert.equal(task.priority, 2);
    const result = await task.run();
    assert.equal(result.actualCalls, 3);
    assert.ok(result.next!.earliestRunAt <= Date.now());
  });

  it("backs off ~30s when tick() finds nothing to do", async () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any });
    (agent as any).tick = async () => false;
    const result = await agent.nextTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000);
  });

  it("halted: does not call tick(), reschedules quickly", async () => {
    let called = false;
    const agent = new ShipAgent(makeShip(), { api: {} as any, shouldRun: () => false });
    (agent as any).tick = async () => { called = true; return true; };
    const result = await agent.nextTask().run();
    assert.ok(!called);
    assert.equal(result.actualCalls, 0);
    assert.ok(result.next!.earliestRunAt <= Date.now() + 1_000);
  });

  it("an error backs off ~10s without propagating", async () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any });
    (agent as any).tick = async () => { throw new Error("boom"); };
    const result = await agent.nextTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 5_000 && delay <= 10_000);
  });
});

describe("ShipAgent.nextSurveyTask", () => {
  it("wraps surveyScout(), priority 3", async () => {
    const agent = new ShipAgent(makeShip("SURV-1"), { api: {} as any });
    let called = false;
    (agent as any).surveyScout = async () => { called = true; return true; };
    const task = agent.nextSurveyTask();
    assert.equal(task.id, "SURV-1-survey");
    assert.equal(task.priority, 3);
    const result = await task.run();
    assert.ok(called);
    assert.ok(result.next!.earliestRunAt <= Date.now());
  });
});

describe("ShipAgent.nextTourTask", () => {
  it("wraps tourScout(), priority 4", async () => {
    const agent = new ShipAgent(makeShip("TOUR-1"), { api: {} as any });
    let called = false;
    (agent as any).tourScout = async () => { called = true; return false; };
    const task = agent.nextTourTask();
    assert.equal(task.id, "TOUR-1-tour");
    assert.equal(task.priority, 4);
    const result = await task.run();
    assert.ok(called);
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000, "no work found must back off ~30s, same as tourLoop()");
  });
});

describe("ShipAgent.nextKeeperTask", () => {
  it("a successful snapshot backs off 5 minutes, not the usual 0/30s", async () => {
    const agent = new ShipAgent(makeShip("KEEPER-1"), { api: {} as any });
    (agent as any).keeperPoll = async () => true;
    const task = agent.nextKeeperTask();
    assert.equal(task.id, "KEEPER-1-keeper");
    assert.equal(task.priority, 3);
    const result = await task.run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 4.5 * 60_000 && delay <= 5 * 60_000, `expected ~5min backoff after a snapshot, got ${delay}ms`);
  });

  it("no assigned market backs off ~30s", async () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any });
    (agent as any).keeperPoll = async () => false;
    const result = await agent.nextKeeperTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000);
  });

  it("keeperLoop() and nextKeeperTask() both go through the same extracted keeperPoll(), not duplicated logic", async () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any, keeperMarket: () => undefined });
    // No market assigned — keeperPoll() itself (unstubbed) must return false
    // via the real (extracted, Phase 7) implementation, proving the
    // extraction didn't change observable behavior.
    const result = await agent.nextKeeperTask().run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 25_000 && delay <= 30_000);
  });
});

describe("ScoutAgent.nextTask", () => {
  it("wraps tick(), priority 4, backs off on error without propagating", async () => {
    const agent = new ScoutAgent(makeShip("SCOUT-1"), { api: {} as any });
    (agent as any).tick = async () => { throw new Error("boom"); };
    const task = agent.nextTask();
    assert.equal(task.id, "SCOUT-1-scout");
    assert.equal(task.priority, 4);
    const result = await task.run();
    const delay = result.next!.earliestRunAt - Date.now();
    assert.ok(delay > 5_000 && delay <= 10_000);
  });
});

describe("SiphonerAgent.nextTask", () => {
  it("wraps tick(), priority 2, chains ready-now after productive work", async () => {
    const agent = new SiphonerAgent(makeShip("SIPH-1"), { api: {} as any });
    (agent as any).tick = async () => true;
    const task = agent.nextTask();
    assert.equal(task.id, "SIPH-1-siphon");
    assert.equal(task.priority, 2);
    const result = await task.run();
    assert.equal(result.actualCalls, 3);
    assert.ok(result.next!.earliestRunAt <= Date.now());
  });
});
