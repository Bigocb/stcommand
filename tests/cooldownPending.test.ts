import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { SiphonerAgent } from "../src/engine/siphoner.js";
import { ScoutAgent } from "../src/engine/scout.js";
import { TraderAgent, type Ship as TraderShip } from "../src/engine/trader.js";
import { CooldownPending, NavigationPending, Pending } from "../src/engine/agentStep.js";

/**
 * Step 1 of docs/control-plane-data-plane.md: "the data plane cannot block."
 *
 * `Scheduler.runOnce()` is strictly sequential — `for (task of ready) await
 * task.run()` — so any sleep inside a task holds every other ship in the
 * tenant, priority-0 rescue included. Transits already yielded via
 * `NavigationPending`; cooldowns did not. A miner's `mineAndRefine()` runs
 * up to 60 extractions, each ending in `waitCooldown()`'s
 * `sleep(remainingSeconds)`, so one miner task could own the whole fleet for
 * the better part of an hour. Doctrine has `minerTarget 4` enabled, so
 * `maybeBuyShip()` arms this the first time the buy conditions are met.
 *
 * These tests pin three things:
 *   1. cooldowns yield (`CooldownPending`) instead of sleeping, but only
 *      when scheduler-driven — a manual `dispatchTo()` must still block;
 *   2. every `nextTask()`-family wrapper reschedules on `Pending`, not just
 *      on the `NavigationPending` subclass;
 *   3. yielding mid-extraction doesn't lose the session — the next tick
 *      keeps mining instead of hauling a five-unit hold off to market, and
 *      reuses the survey it already paid for.
 */

function makeShip(symbol = "SHIP-1"): Ship {
  return {
    symbol,
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
    cooldown: { remainingSeconds: 0 },
    mounts: [{ symbol: "MOUNT_MINING_LASER_I" }],
    modules: [],
  } as unknown as Ship;
}

describe("waitCooldown(): yields the scheduler instead of sleeping", () => {
  it("ShipAgent throws CooldownPending at the real cooldown expiry when scheduler-driven", async () => {
    const ship = makeShip();
    (ship as any).cooldown = { remainingSeconds: 70 };
    const agent = new ShipAgent(ship, { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).schedulerDriven = true;

    const before = Date.now();
    await assert.rejects(
      () => (agent as any).waitCooldown(),
      (err: unknown) =>
        err instanceof CooldownPending &&
        err.reason === "cooldown" &&
        err.resumeAt >= before + 70_000 &&
        err.resumeAt <= before + 71_000,
    );
  });

  it("SiphonerAgent throws CooldownPending when scheduler-driven", async () => {
    const ship = makeShip("SIPH-1");
    (ship as any).cooldown = { remainingSeconds: 70 };
    const agent = new SiphonerAgent(ship as any, { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).schedulerDriven = true;

    await assert.rejects(
      () => (agent as any).waitCooldown(),
      (err: unknown) => err instanceof CooldownPending,
    );
  });

  it("TraderAgent's cooldown yield is a CooldownPending, not a NavigationPending mislabelled as transit", async () => {
    // It already threw here, but as NavigationPending — which reports
    // reason "transit" to anything that reads it (dashboards, telemetry,
    // the intent model in docs/control-plane-data-plane.md §5).
    const ship = { ...makeShip("TRD-1"), cooldown: { remainingSeconds: 42 } } as unknown as TraderShip;
    const agent = new TraderAgent(ship, { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).schedulerDriven = true;

    await assert.rejects(
      () => (agent as any).waitCooldown(),
      (err: unknown) => err instanceof CooldownPending && err.reason === "cooldown",
    );
  });

  it("still blocks (does not throw) when NOT scheduler-driven, so a manual dispatchTo() behaves exactly as before", async () => {
    const ship = makeShip();
    // 0 remaining: returns immediately either way. The point is the absence
    // of a throw on the manual path — a dispatchTo() has no Task to reschedule.
    (ship as any).cooldown = { remainingSeconds: 0 };
    const agent = new ShipAgent(ship, { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).schedulerDriven = false;
    await (agent as any).waitCooldown(); // must not throw
  });
});

describe("nextTask() family reschedules on any Pending, not only NavigationPending", () => {
  const resumeAt = Date.now() + 70_000;

  it("ShipAgent.nextTask (miner) reschedules at the cooldown expiry", async () => {
    const agent = new ShipAgent(makeShip("MINER-1"), { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).tick = async () => { throw new CooldownPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt, "a cooldown must schedule the next attempt for when it actually expires");
  });

  it("ShipAgent.nextSurveyTask reschedules at the cooldown expiry", async () => {
    const agent = new ShipAgent(makeShip("SURV-1"), { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).surveyScout = async () => { throw new CooldownPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextSurveyTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
  });

  it("SiphonerAgent.nextTask reschedules at the cooldown expiry", async () => {
    const agent = new SiphonerAgent(makeShip("SIPH-1") as any, { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).tick = async () => { throw new CooldownPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
  });

  it("TraderAgent.nextTask reschedules at the cooldown expiry", async () => {
    const ship = makeShip("TRD-1") as unknown as TraderShip;
    const agent = new TraderAgent(ship, { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).tick = async () => { throw new CooldownPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
  });

  it("a transit still reschedules at arrival — NavigationPending is a Pending, so the widened guard didn't drop it", async () => {
    const agent = new ShipAgent(makeShip("MINER-2"), { api: { getCallCount: () => 0 } as any, log: () => {} });
    (agent as any).tick = async () => { throw new NavigationPending(resumeAt); };
    agent.running = true;
    const result = await agent.nextTask().run();
    assert.equal(result.next!.earliestRunAt, resumeAt);
    assert.ok(new NavigationPending(1) instanceof Pending, "NavigationPending must remain a Pending subclass");
  });
});

describe("an extraction session survives being interrupted by its own cooldown", () => {
  /** A miner standing on an asteroid with a part-filled hold. */
  function minerAt(waypoint: string, units: number): Ship {
    const ship = makeShip("MINER-S");
    (ship as any).nav = { status: "IN_ORBIT", waypointSymbol: waypoint, systemSymbol: "X1-A" };
    (ship as any).cargo = { capacity: 40, units, inventory: units > 0 ? [{ symbol: "IRON_ORE", units }] : [] };
    return ship;
  }

  it("keeps mining rather than hauling a five-unit hold to market", async () => {
    // The failure mode without this: each extraction's cooldown ends the
    // tick, the next tick sees cargo > 0, and tick()'s step 2 flies the ship
    // off to sell five units. A miner would never fill a hold again.
    const ship = minerAt("X1-A-AST1", 5);
    const agent = new ShipAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: () => {} });
    agent.withWorld([{ symbol: "X1-A-AST1", x: 0, y: 0, type: "ASTEROID_FIELD" }] as any, []);
    (agent as any).miningSession = "X1-A-AST1"; // a session interrupted mid-extraction

    let sold = false;
    let mined = false;
    (agent as any).pickSellTarget = () => { sold = true; return "X1-A-MKT"; };
    (agent as any).extractUntilFull = async () => { mined = true; };
    (agent as any).ensureInOrbit = async () => {};
    (agent as any).navigateTo = async () => {};
    (agent as any).refuelIfNeeded = async () => true;

    await agent.tick();

    assert.equal(sold, false, "must not look for a sell target mid-session");
    assert.equal(mined, true, "must resume extracting at the asteroid it is standing on");
  });

  it("abandons the session once the ship is no longer at that waypoint", async () => {
    // The session is a resumption hint, not a lock: a ship that got moved
    // (rescue tender, manual dispatch, repair diversion) must fall back to
    // normal tick() behavior and sell what it is carrying.
    const ship = minerAt("X1-A-MKT", 5); // moved away from the asteroid
    const agent = new ShipAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: () => {} });
    agent.withWorld([{ symbol: "X1-A-MKT", x: 0, y: 0 }] as any, []);
    (agent as any).miningSession = "X1-A-AST1"; // stale: session was at the asteroid

    let sold = false;
    (agent as any).pickSellTarget = () => { sold = true; return undefined; };
    (agent as any).discoverMarkets = async () => false;
    (agent as any).ensureInOrbit = async () => {};
    (agent as any).navigateTo = async () => {};
    (agent as any).refuelIfNeeded = async () => true;

    await agent.tick();

    assert.equal(sold, true, "a ship that left the asteroid is no longer mid-session");
    assert.equal((agent as any).miningSession, null, "the stale session must be cleared");
  });

  it("reuses the survey it already paid for instead of buying a new one every extraction", async () => {
    // createAndPickSurvey() costs an API call AND puts the ship on a
    // cooldown of its own. Re-surveying on every resumed tick would mean a
    // survey per extraction — strictly worse than not surveying at all.
    const ship = minerAt("X1-A-AST1", 5);
    const agent = new ShipAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: () => {} });
    const survey = { signature: "SIG-1", symbol: "X1-A-AST1", deposits: [{ symbol: "IRON_ORE" }], expiration: new Date(Date.now() + 600_000).toISOString(), size: "LARGE" };
    (agent as any).activeSurvey = { waypoint: "X1-A-AST1", survey };

    assert.equal((agent as any).cachedSurvey(), survey, "a live survey for this waypoint must be reused");
  });

  it("discards a cached survey belonging to a different waypoint, or one that has expired", async () => {
    const ship = minerAt("X1-A-AST1", 5);
    const agent = new ShipAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: () => {} });
    const base = { signature: "SIG-1", symbol: "X1-A-AST2", deposits: [{ symbol: "IRON_ORE" }], size: "LARGE" };

    (agent as any).activeSurvey = { waypoint: "X1-A-AST2", survey: { ...base, expiration: new Date(Date.now() + 600_000).toISOString() } };
    assert.equal((agent as any).cachedSurvey(), undefined, "a survey for another asteroid is not usable here");

    (agent as any).activeSurvey = { waypoint: "X1-A-AST1", survey: { ...base, expiration: new Date(Date.now() - 1_000).toISOString() } };
    assert.equal((agent as any).cachedSurvey(), undefined, "an expired survey must not be handed to extractWithSurvey()");
  });
});

describe("ScoutAgent honours refuelIfNeeded()'s refusal", () => {
  it("holds instead of flying a leg it was just told it cannot fuel", async () => {
    // The same bug already fixed in tourScout(): the return value was
    // discarded and the navigate fired anyway, producing a "requires N more
    // fuel" rejection and a 10-second retry loop against the same target.
    const ship = makeShip("SCOUT-1");
    const logs: string[] = [];
    const agent = new ScoutAgent(ship as any, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      log: (m: string) => logs.push(m),
    });
    agent.withWorld([
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-B9", x: 10, y: 0 },
    ] as any, []);

    let navigated = false;
    (agent as any).refuelIfNeeded = async () => false; // cannot fuel, nowhere reachable
    (agent as any).navigateTo = async () => { navigated = true; };

    const worked = await agent.tick();

    assert.equal(navigated, false, "must not attempt a leg it cannot fuel");
    assert.equal(worked, false);
    assert.ok(logs.some((l) => l.includes("not enough fuel")), "must say why it is holding");
  });
});
