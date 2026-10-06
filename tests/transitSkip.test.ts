import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRANSIT_SKIP_MS, transitResumeAt } from "../src/engine/transit.js";
import { FeedManager } from "../src/engine/feed.js";
import { MissionManager } from "../src/engine/mission.js";

/**
 * Feed and mission crews used to re-read each ship on every pass and return
 * early when it was still flying — a carrier on a long leg was polled every
 * few seconds the whole way (about a third of the game-API budget). They now
 * sleep it until it lands.
 */

const inTransit = (arrivalInMs: number | undefined, now = Date.now()) => ({
  symbol: "S-1",
  nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-1", ...(arrivalInMs === undefined ? {} : { route: { arrival: new Date(now + arrivalInMs).toISOString() } }) },
  fuel: { capacity: 100, current: 100 },
  cargo: { capacity: 40, units: 0, inventory: [] },
}) as any;

describe("transitResumeAt", () => {
  const now = 1_000_000_000_000;
  it("is undefined for a ship that is not in transit", () => {
    assert.equal(transitResumeAt({ nav: { status: "DOCKED" } }, now), undefined);
  });
  it("is the arrival time plus a second", () => {
    assert.equal(transitResumeAt(inTransit(5 * 60_000, now), now), now + 5 * 60_000 + 1_000);
  });
  it("never parks a ship longer than the cap", () => {
    assert.equal(transitResumeAt(inTransit(6 * 3_600_000, now), now), now + MAX_TRANSIT_SKIP_MS);
  });
  it("is undefined without a usable arrival, so the old every-pass read still happens", () => {
    assert.equal(transitResumeAt(inTransit(undefined, now), now), undefined);
    assert.equal(transitResumeAt({ nav: { status: "IN_TRANSIT", route: { arrival: "not a date" } } }, now), undefined);
  });
  it("does not return a time in the past for a ship that is just landing", () => {
    assert.equal(transitResumeAt(inTransit(-30_000, now), now), now);
  });
});

describe("feed carriers in flight", () => {
  it("sleeps a carrier until it lands and makes no cargo call meanwhile", async () => {
    let cargoCalls = 0;
    const fm = new FeedManager({
      api: { getShipCargo: async () => { cargoCalls += 1; return { inventory: [], capacity: 40, units: 0 }; } } as any,
      getShip: async () => inTransit(10 * 60_000),
    } as any);
    await fm.start("X1-A-2", "IRON", { carrierTarget: 1 });
    const feed = (await fm.list())[0]!;
    const t: any = { retryAt: 0 };

    await (fm as any).stepCarrier(feed, "S-1", t);

    assert.ok(t.retryAt > Date.now() + 9 * 60_000, `expected a wake time ~10 minutes out, got ${t.retryAt - Date.now()}ms`);
    assert.equal(cargoCalls, 0);
  });

  it("leaves retryAt alone when the ship carries no arrival time", async () => {
    const fm = new FeedManager({ api: {} as any, getShip: async () => inTransit(undefined) } as any);
    await fm.start("X1-A-2", "IRON", { carrierTarget: 1 });
    const feed = (await fm.list())[0]!;
    const t: any = { retryAt: 0 };
    await (fm as any).stepCarrier(feed, "S-1", t);
    assert.equal(t.retryAt, 0);
  });

  it("does not shorten a backoff that is already longer than the flight", async () => {
    const fm = new FeedManager({ api: {} as any, getShip: async () => inTransit(60_000) } as any);
    await fm.start("X1-A-2", "IRON", { carrierTarget: 1 });
    const feed = (await fm.list())[0]!;
    const later = Date.now() + 20 * 60_000;
    const t: any = { retryAt: later };
    await (fm as any).stepCarrier(feed, "S-1", t);
    assert.equal(t.retryAt, later);
  });
});

describe("feed collectors in flight", () => {
  it("reads the collector once per flight, not once per pass", async () => {
    let reads = 0;
    const fm = new FeedManager({ api: {} as any, getShip: async () => { reads += 1; return inTransit(10 * 60_000); } } as any);
    await fm.start("X1-A-2", "IRON", { carrierTarget: 1 });
    const feed = { ...(await fm.list())[0]!, collector: "C-1", field: "X1-A-F" } as any;

    for (let i = 0; i < 10; i += 1) await (fm as any).stepCollector(feed);

    assert.equal(reads, 1);
  });
});

describe("mission carriers in flight", () => {
  it("sleeps a carrier until it lands", async () => {
    const mgr = new MissionManager({ api: {} as any, getShip: async () => inTransit(8 * 60_000) } as any);
    const t: any = { step: "source", retryAt: 0 };
    await (mgr as any).stepCarrier({ targetWaypoint: "X1-A-I1", targetSystem: "X1-A", materials: [] }, "S-1", t);
    assert.ok(t.retryAt > Date.now() + 7 * 60_000, `got ${t.retryAt - Date.now()}ms`);
  });
});
