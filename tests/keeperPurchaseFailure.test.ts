import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { deliveryExpired, MAX_DELIVERY_MS } from "../src/engine/keeperDelivery.js";

/**
 * What the keeper purchase tells its caller (2026-10-31 review): a failed buy must read as failed and hold the market back; a failure
 * AFTER the hull is bought must never read as "the purchase failed" (the next pass would buy a second probe for the same market).
 * No database: the store, ledger and role setting are fakes.
 */
const YARD = "X1-T-YARD";
const MARKET = "X1-T-M1";
const FAR_MARKET = "X1-U-M1";

function makeFleet(over: { purchase?: () => Promise<unknown>; ledger?: () => void; setRole?: () => Promise<void>; hold?: () => Promise<void> } = {}) {
  const seen = { roles: [] as unknown[][], holds: [] as unknown[][], logs: [] as string[] };
  const fleet = new FleetManager({
    api: {
      purchaseShip: over.purchase ?? (async () => ({ ship: { symbol: "P-1", frame: { symbol: "FRAME_PROBE" } }, transaction: { price: 28_000 } })),
    } as any,
  }) as any;
  fleet.tenantId = "t1";
  fleet.windDownBlocksBuys = () => false;
  fleet.keeperTargetCovered = async () => false;
  fleet.log = (m: string) => { seen.logs.push(m); };
  fleet.recordLedger = over.ledger ?? (() => {});
  fleet.doctrine = { ensureShipTypeRule: async () => {} };
  fleet.setShipRole = over.setRole ?? (async (...a: unknown[]) => { seen.roles.push(a); });
  fleet.updateShipManualState = over.hold ?? (async (...a: unknown[]) => { seen.holds.push(a); });
  fleet.dispatcher = { release: () => {} };
  fleet.shipRegistry = { claim: () => {} };
  fleet.roleOf = () => "keeper";
  fleet.loadKeeperDeliveries = async () => {};
  fleet.saveKeeperDeliveries = async () => {};
  fleet.keeperPriorityMarkets = async () => [];
  fleet.setKeeperPriorityMarkets = async () => [];
  const book = { queueCooldown: new Map<string, number>(), yardWait: new Map(), surveyRetry: new Map(), topUp: new Map() };
  fleet.timers = () => ({ load: async () => {}, save: async () => {}, book });
  fleet.timersDoc = { book };
  return { fleet, seen, book };
}

describe("purchaseKeeperProbe result", () => {
  it("a failed purchase reads as failed and holds the market back", async () => {
    const { fleet, seen, book } = makeFleet({ purchase: async () => { throw new Error("insufficient credits"); } });
    assert.equal(await fleet.purchaseKeeperProbe(YARD, MARKET, 28_000, "SHIP_PROBE"), "failed");
    assert.equal(seen.roles.length, 0);
    assert.ok((book.queueCooldown.get(MARKET) ?? 0) > Date.now(), "the queue skips the market for a while instead of retrying it every tick");
  });

  it("a ledger failure after the hull is bought changes nothing: still bought and still pinned", async () => {
    const { fleet, seen, book } = makeFleet({ ledger: () => { throw new Error("db down"); } });
    assert.equal(await fleet.purchaseKeeperProbe(YARD, MARKET, 28_000, "SHIP_PROBE"), "bought");
    assert.deepEqual(seen.roles, [["P-1", "keeper", MARKET]]);
    assert.equal(book.queueCooldown.has(MARKET), false);
  });

  it("a role failure after the buy reads as bought and holds the market so a second probe is not bought", async () => {
    const { fleet, book, seen } = makeFleet({ setRole: async () => { throw new Error("write failed"); } });
    assert.equal(await fleet.purchaseKeeperProbe(YARD, MARKET, 28_000, "SHIP_PROBE"), "bought");
    assert.ok((book.queueCooldown.get(MARKET) ?? 0) > Date.now() + 25 * 60_000);
    assert.ok(seen.logs.some((l) => /bought for X1-T-M1 but the keeper role could not be set/.test(l)));
  });

  it("a delivery is recorded even when the hold write fails, so the delivery check can put the hold back", async () => {
    const { fleet } = makeFleet({ hold: async () => { throw new Error("write failed"); } });
    fleet.keeperDeliveries = new Map();
    assert.equal(await fleet.purchaseKeeperProbe(YARD, FAR_MARKET, 28_000, "SHIP_PROBE"), "bought");
    assert.equal(fleet.keeperDeliveries.get("P-1"), FAR_MARKET);
  });

  it("skips (no purchase) when the market already has a keeper", async () => {
    let bought = 0;
    const { fleet } = makeFleet({ purchase: async () => { bought++; return {}; } });
    fleet.keeperTargetCovered = async () => true;
    assert.equal(await fleet.purchaseKeeperProbe(YARD, MARKET, 28_000, "SHIP_PROBE"), "skipped");
    assert.equal(bought, 0);
  });
});

describe("delivery expiry", () => {
  it("expires after the limit, never before it and never without a start time", () => {
    const t0 = 1_000_000;
    assert.equal(deliveryExpired(t0, t0 + MAX_DELIVERY_MS - 1), false);
    assert.equal(deliveryExpired(t0, t0 + MAX_DELIVERY_MS), true);
    assert.equal(deliveryExpired(undefined, t0 + 10 * MAX_DELIVERY_MS), false);
    assert.equal(deliveryExpired(t0, t0 + 10 * MAX_DELIVERY_MS, 0), false, "0 = never");
  });
});

describe("advanceKeeperDeliveries expiry", () => {
  it("parks a probe whose delivery has run too long, drops its keeper pin and forgets the delivery", async () => {
    const { fleet, seen } = makeFleet();
    const parked: string[] = [];
    fleet.keeperDeliveries = new Map([["P-1", FAR_MARKET]]);
    fleet.keeperDeliveriesLoaded = true;
    fleet.keeperMarkets = new Map([["P-1", FAR_MARKET]]);
    fleet.shipFor = () => ({ nav: { systemSymbol: "X1-T" } });
    fleet.parkShip = async (s: string) => { parked.push(s); };
    fleet.deliverySeenAt = new Map([["P-1", Date.now() - MAX_DELIVERY_MS - 1000]]);
    await fleet.advanceKeeperDeliveries();
    assert.deepEqual(parked, ["P-1"]);
    assert.equal(fleet.keeperDeliveries.size, 0);
    assert.equal(fleet.keeperMarkets.has("P-1"), false, "its market reads uncovered again");
    assert.ok(seen.logs.some((l) => /giving it up and parking/.test(l)));
  });

  it("leaves a delivery that is still inside the limit alone", async () => {
    const { fleet } = makeFleet();
    const parked: string[] = [];
    fleet.keeperDeliveries = new Map([["P-1", FAR_MARKET]]);
    fleet.keeperDeliveriesLoaded = true;
    fleet.shipFor = () => ({ nav: { systemSymbol: "X1-T" } });
    fleet.operatorHolds = new Map([["P-1", FAR_MARKET]]);
    fleet.parkShip = async (s: string) => { parked.push(s); };
    await fleet.advanceKeeperDeliveries();
    assert.deepEqual(parked, []);
    assert.equal(fleet.keeperDeliveries.size, 1);
  });
});
