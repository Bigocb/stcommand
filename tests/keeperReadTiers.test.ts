import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KEEPER_READ_TIER_POLICY as P, boardFactsByMarket, classifyKeeperMarket, classifyKeeperMarkets, keeperReadIntervals, summarizeKeeperReadTiers,
  type KeeperMarketFacts,
} from "../src/engine/keeperReadTiers.js";
import { KeeperReadTiersLive } from "../src/engine/keeperReadTiersLive.js";
import { Doctrine } from "../src/engine/doctrine.js";
import { ShipAgent, type Ship } from "../src/engine/agent.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const facts = (over: Partial<KeeperMarketFacts> = {}): KeeperMarketFacts => ({ waypoint: "X1-A-A1", assignedRoute: false, ...over });

describe("keeper read tiers: classification", () => {
  it("HOT for an assigned route's market, whatever else is true", () => {
    const d = classifyKeeperMarket(facts({ assignedRoute: true, bestLegProfit: 1 }), P, NOW);
    assert.equal(d.tier, "HOT");
    assert.equal(d.intervalMs, 10 * MIN);
    assert.match(d.reason, /^HOT every 10m: an assigned trader route/);
  });

  it("HOT for a market on the board's top N, WARM just past it (boundary at rank N-1)", () => {
    assert.equal(classifyKeeperMarket(facts({ boardRank: 9, bestLegProfit: 20_000 }), P, NOW).tier, "HOT");
    const tenth = classifyKeeperMarket(facts({ boardRank: 10, bestLegProfit: 20_000 }), P, NOW);
    assert.equal(tenth.tier, "WARM");
    assert.match(tenth.reason, /board leg worth 20000c\/trip/);
    assert.match(classifyKeeperMarket(facts({ boardRank: 0 }), P, NOW).reason, /board route #1 \(top 10\)/);
  });

  it("topN 0 leaves only assigned routes HOT", () => {
    assert.equal(classifyKeeperMarket(facts({ boardRank: 0, bestLegProfit: 50_000 }), { ...P, topN: 0 }, NOW).tier, "WARM");
  });

  it("WARM at exactly the profit threshold, COLD just under it", () => {
    assert.equal(classifyKeeperMarket(facts({ boardRank: 50, bestLegProfit: 10_000 }), P, NOW).tier, "WARM");
    const under = classifyKeeperMarket(facts({ boardRank: 50, bestLegProfit: 9_999 }), P, NOW);
    assert.equal(under.tier, "COLD");
    assert.match(under.reason, /best board leg 9999c\/trip, under 10000, no recent trade/);
  });

  it("a threshold of 0 still needs a leg that makes money", () => {
    assert.equal(classifyKeeperMarket(facts({ boardRank: 50, bestLegProfit: 0 }), { ...P, warmMinProfit: 0 }, NOW).tier, "COLD");
  });

  it("WARM for a trade inside the window (boundary inclusive), COLD just outside it", () => {
    const inside = classifyKeeperMarket(facts({ lastTradeAt: NOW - 3 * 60 * MIN }), P, NOW);
    assert.equal(inside.tier, "WARM");
    assert.match(inside.reason, /we traded here 180m ago \(within 180m\)/);
    assert.equal(classifyKeeperMarket(facts({ lastTradeAt: NOW - 3 * 60 * MIN - 1 }), P, NOW).tier, "COLD");
  });

  it("COLD with nothing at all, at the cold interval", () => {
    const d = classifyKeeperMarket(facts(), P, NOW);
    assert.equal(d.tier, "COLD");
    assert.equal(d.intervalMs, 100 * MIN);
    assert.match(d.reason, /no board route and no recent trade; never read$/);
  });

  it("caps an interval at the ceiling and says so", () => {
    const d = classifyKeeperMarket(facts(), { ...P, ceilingMs: 85 * MIN }, NOW);
    assert.equal(d.intervalMs, 85 * MIN);
    assert.match(d.reason, /COLD every 85m \(capped at Intel freshness\)/);
    assert.equal(classifyKeeperMarket(facts({ assignedRoute: true }), { ...P, ceilingMs: 85 * MIN }, NOW).intervalMs, 10 * MIN);
  });

  it("due now when never read or read longer ago than the interval; otherwise the time left", () => {
    assert.equal(classifyKeeperMarket(facts(), P, NOW).dueInMs, 0);
    assert.equal(classifyKeeperMarket(facts({ assignedRoute: true, lastReadAt: NOW - 11 * MIN }), P, NOW).dueInMs, 0);
    assert.equal(classifyKeeperMarket(facts({ assignedRoute: true, lastReadAt: NOW - 10 * MIN }), P, NOW).dueInMs, 0);
    const d = classifyKeeperMarket(facts({ assignedRoute: true, lastReadAt: NOW - 4 * MIN }), P, NOW);
    assert.equal(d.dueInMs, 6 * MIN);
    assert.match(d.reason, /read 4m ago$/);
  });

  it("never gives an interval under a minute", () => {
    assert.equal(classifyKeeperMarket(facts({ assignedRoute: true }), { ...P, hotMs: 0 }, NOW).intervalMs, MIN);
  });
});

describe("keeper read tiers: helpers", () => {
  it("keeperReadIntervals gives waypoint -> intervalMs", () => {
    const ds = classifyKeeperMarkets([facts({ waypoint: "H", assignedRoute: true }), facts({ waypoint: "W", lastTradeAt: NOW }), facts({ waypoint: "C" })], P, NOW);
    const m = keeperReadIntervals(ds);
    assert.ok(m instanceof Map);
    assert.deepEqual([...m.entries()], [["H", 10 * MIN], ["W", 30 * MIN], ["C", 100 * MIN]]);
  });

  it("boardFactsByMarket ranks by profit whatever the order given, takes each market's best, and marks assigned ends", () => {
    const b = boardFactsByMarket(
      [
        { buyAt: "A", sellAt: "B", profitPerTrip: 5_000 },
        { buyAt: "C", sellAt: "B", profitPerTrip: 90_000 },
        { buyAt: "D", sellAt: "D", profitPerTrip: 1_000 },
      ],
      [{ buyAt: "E", sellAt: "A" }, {}],
    );
    assert.deepEqual(b.get("B"), { assignedRoute: false, boardRank: 0, bestLegProfit: 90_000 });
    assert.deepEqual(b.get("C"), { assignedRoute: false, boardRank: 0, bestLegProfit: 90_000 });
    assert.deepEqual(b.get("A"), { assignedRoute: true, boardRank: 1, bestLegProfit: 5_000 });
    assert.deepEqual(b.get("D"), { assignedRoute: false, boardRank: 2, bestLegProfit: 1_000 });
    assert.deepEqual(b.get("E"), { assignedRoute: true });
  });

  it("summary counts per tier and stretches the pass when keepers ask for more reads than they get", () => {
    const fs = [
      facts({ waypoint: "H1", assignedRoute: true, lastReadAt: NOW - 2 * MIN }),
      facts({ waypoint: "H2", assignedRoute: true, lastReadAt: NOW - 20 * MIN }),
      facts({ waypoint: "W1", lastTradeAt: NOW, lastReadAt: NOW - 6 * MIN }),
      facts({ waypoint: "C1" }),
    ];
    const ds = classifyKeeperMarkets(fs, P, NOW);
    const reads = new Map(fs.map((f) => [f.waypoint, f.lastReadAt !== undefined ? { lastReadAt: f.lastReadAt } : {}]));
    // Demand: 2/10 + 1/30 + 1/100 = 0.2433 a minute.
    const ample = summarizeKeeperReadTiers(ds, reads, NOW, 5);
    assert.equal(ample.stretch, 1);
    assert.deepEqual(ample.tiers.map((t) => [t.tier, t.markets, t.intervalMin, t.effectivePassMin]), [["HOT", 2, 10, 10], ["WARM", 1, 30, 30], ["COLD", 1, 100, 100]]);
    const hot = ample.tiers[0]!;
    assert.equal(hot.readAgeMedianMin, 2);
    assert.equal(hot.readAgeMaxMin, 20);
    assert.equal(hot.dueNow, 1);
    assert.equal(ample.tiers[2]!.readAgeMedianMin, null);
    const short = summarizeKeeperReadTiers(ds, reads, NOW, 0.24333333 / 2);
    assert.equal(short.stretch, 2);
    assert.equal(short.tiers[0]!.effectivePassMin, 20);
    assert.equal(summarizeKeeperReadTiers(ds, reads, NOW).measuredReadsPerMin, null);
  });
});

function live(doctrine: Doctrine, over: Partial<ConstructorParameters<typeof KeeperReadTiersLive>[0]> = {}) {
  return new KeeperReadTiersLive({
    doctrine,
    routes: () => [{ buyAt: "X1-A-B1", sellAt: "X1-A-B2", profitPerTrip: 600_000 }],
    assignments: () => [{ buyAt: "X1-A-T1", sellAt: "X1-A-T2" }],
    lastTrades: () => new Map([["X1-A-S1", NOW - 30 * MIN]]),
    lastReadAt: () => NOW - 4 * MIN,
    ...over,
  });
}

describe("keeper read tiers: the fleet's side", () => {
  it("off (the default) = no tier, no interval, no wait: today's behaviour", () => {
    const t = live(new Doctrine());
    assert.equal(t.policy(), undefined);
    assert.equal(t.intervalMs("X1-A-T1", NOW), undefined);
    assert.equal(t.waitMs("X1-A-T1", NOW), undefined);
    assert.equal(t.intervals(["X1-A-T1"], NOW).size, 0);
    assert.equal(t.report(["X1-A-T1"], NOW).enabled, false);
  });

  it("on: tiers from the board, the assignments and our trades, knobs from doctrine, cold capped under Intel freshness", async () => {
    const d = new Doctrine();
    await d.set("keeperReadTiers", { enabled: true });
    const t = live(d);
    const m = t.intervals(["X1-A-T1", "X1-A-B2", "X1-A-S1", "X1-A-Q1"], NOW);
    assert.deepEqual([...m.entries()], [["X1-A-T1", 10 * MIN], ["X1-A-B2", 10 * MIN], ["X1-A-S1", 30 * MIN], ["X1-A-Q1", 85 * MIN]]);
    assert.equal(t.waitMs("X1-A-T1", NOW), 6 * MIN);
    await d.set("keeperReadHotMin", { value: 15 });
    await d.set("snapshotMaxAgeMin", { value: 180 });
    assert.equal(t.intervalMs("X1-A-T1", NOW), 15 * MIN);
    assert.equal(t.intervalMs("X1-A-Q1", NOW), 100 * MIN);
    await d.set("keeperReadTopRoutes", { value: 0 });
    assert.equal(t.decide("X1-A-B2", NOW)?.tier, "WARM");
    const r = t.report(["X1-A-T1", "X1-A-Q1"], NOW, 10) as any;
    assert.equal(r.enabled, true);
    assert.deepEqual(r.tiers.map((x: any) => x.markets), [1, 0, 1]);
  });

  it("rebuilds the board cache after a minute, not before", async () => {
    const d = new Doctrine();
    await d.set("keeperReadTiers", { enabled: true });
    let builds = 0;
    const t = live(d, { routes: () => { builds++; return []; } });
    t.intervalMs("X1-A-Q1", NOW);
    t.intervalMs("X1-A-Q1", NOW + 59_000);
    assert.equal(builds, 1);
    t.intervalMs("X1-A-Q1", NOW + 60_000);
    assert.equal(builds, 2);
  });
});

describe("keeper read tiers: FleetManager.keeperPollMs", () => {
  it("off = the price-change cadence; on = the tier's interval", async () => {
    const { FleetManager } = await import("../src/engine/fleet.js");
    const fleet = new FleetManager({ api: {} as any, log: () => {} });
    const before = fleet.keeperPollMs("X1-Z-Q1");
    assert.equal(before, 5 * MIN, "no history: the cadence floor, as before");
    await fleet.doctrine.set("keeperReadTiers", { enabled: true });
    assert.equal(fleet.keeperPollMs("X1-Z-Q1"), 85 * MIN, "COLD, capped 5 minutes under the 90-minute Intel freshness");
    await fleet.doctrine.set("keeperReadTiers", { enabled: false });
    assert.equal(fleet.keeperPollMs("X1-Z-Q1"), before);
  });
});

function makeShip(symbol: string, waypoint = "X1-A-A1"): Ship {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: waypoint, systemSymbol: "X1-A" },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 100, capacity: 100 },
  } as unknown as Ship;
}

describe("keeper read tiers: the keeper task seam", () => {
  it("a keeper at its market whose read is not due waits without a call", async () => {
    let polled = 0;
    const agent = new ShipAgent(makeShip("K-1"), { api: { getCallCount: () => 0 } as any, keeperMarket: () => "X1-A-A1", keeperReadWaitMs: () => 7 * MIN });
    (agent as any).keeperPoll = async () => { polled++; return true; };
    agent.running = true;
    const r = await agent.nextKeeperTask().run();
    assert.equal(polled, 0);
    assert.equal(r.actualCalls, 0);
    const delay = r.next!.earliestRunAt - Date.now();
    assert.ok(delay > 6.9 * MIN && delay <= 7 * MIN, `expected ~7m, got ${delay}`);
  });

  it("clause off (undefined) or due (0) reads exactly as before", async () => {
    for (const wait of [undefined, 0]) {
      let polled = 0;
      const agent = new ShipAgent(makeShip("K-2"), { api: { getCallCount: () => 0 } as any, keeperMarket: () => "X1-A-A1", keeperReadWaitMs: () => wait });
      (agent as any).keeperPoll = async () => { polled++; return true; };
      agent.running = true;
      await agent.nextKeeperTask().run();
      assert.equal(polled, 1, `wait ${wait}`);
    }
  });

  it("a keeper not yet at its market, a loop keeper, or one with a hold goal is not held back", async () => {
    const cases = [
      new ShipAgent(makeShip("K-3", "X1-A-B9"), { api: { getCallCount: () => 0 } as any, keeperMarket: () => "X1-A-A1", keeperReadWaitMs: () => 7 * MIN }),
      new ShipAgent(makeShip("K-4"), { api: { getCallCount: () => 0 } as any, keeperMarket: () => "X1-A-A1", keeperLooping: () => true, keeperReadWaitMs: () => 7 * MIN }),
      new ShipAgent(makeShip("K-5"), { api: { getCallCount: () => 0 } as any, keeperMarket: () => "X1-A-A1", intentFor: () => ({ goal: { kind: "hold", waypoint: "X1-A-A1" } }) as any, keeperReadWaitMs: () => 7 * MIN }),
    ];
    for (const agent of cases) {
      let polled = 0;
      (agent as any).keeperPoll = async () => { polled++; return true; };
      agent.running = true;
      await agent.nextKeeperTask().run();
      assert.equal(polled, 1, agent.symbol);
    }
  });
});
