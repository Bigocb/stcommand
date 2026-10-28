import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sinkPreflight } from "../src/engine/sinkPreflight.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

const base = { costPerUnit: 33_785, units: 40, lotSize: 18, impactPerLot: 0.06, maxLossPct: 10 };

describe("sinkPreflight: is the destination still worth the trip?", () => {
  it("2026-10-28 KR9-A1: a bid of 25,731 against a cost of 33,785 is refused", () => {
    const v = sinkPreflight({ ...base, bid: 25_731 });
    assert.equal(v.ok, false);
    assert.match(v.reason, /destination bids 25,731c/);
    assert.match(v.reason, /under the loss floor 30,407c/);
  });

  it("the bid the trip was bought on (58,294) goes ahead", () => {
    assert.equal(sinkPreflight({ ...base, bid: 58_294 }).ok, true);
  });

  it("the price impact of the lots counts: a bid just over the floor fails once 3 lots are discounted", () => {
    assert.equal(sinkPreflight({ ...base, units: 18, bid: 30_600 }).ok, true, "one lot, no discount: over 30,407");
    assert.equal(sinkPreflight({ ...base, units: 54, bid: 30_600 }).ok, false, "three lots average 6% lower: 28,764");
  });

  it("no reading, no impact setting or no cost basis judges nothing", () => {
    assert.equal(sinkPreflight({ ...base, bid: undefined }).ok, true);
    assert.equal(sinkPreflight({ ...base, bid: 1, impactPerLot: 0 }).ok, true);
    assert.equal(sinkPreflight({ ...base, bid: 1, costPerUnit: 0 }).ok, true);
  });
});

/** The real deliverHeldCargo(): cargo bought at B1, destination A1 in another place; a fake store of snapshots. */
function setup(snap: { sellPrice: number; ageMin: number } | undefined, o: { impact?: number; pinned?: boolean } = {}) {
  const ship = { symbol: "S-1", nav: { status: "DOCKED", waypointSymbol: "X1-Q-B1", systemSymbol: "X1-Q" }, cargo: { capacity: 80, units: 40, inventory: [{ symbol: "GRAVITON_EMITTERS", units: 40 }] }, fuel: { current: 100, capacity: 100 } } as unknown as Ship;
  const logs: string[] = [];
  const t = new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    assignedRoute: () => undefined,
    getCredits: () => 1_000_000,
    buyGuardImpactPct: () => o.impact ?? 6,
    maxLossPct: 10,
    log: (m: string) => logs.push(m),
    getMarketSnapshots: async () => (snap ? [{ waypointSymbol: "X1-Q-A1", goodSymbol: "GRAVITON_EMITTERS", purchasePrice: 99_999, sellPrice: snap.sellPrice, tradeVolume: 18, timestamp: new Date(Date.now() - snap.ageMin * 60_000).toISOString() }] : []),
  } as never);
  t.withWorld([{ symbol: "X1-Q-B1", x: 0, y: 0 }, { symbol: "X1-Q-A1", x: 10, y: 0 }]);
  let navigated = 0;
  (t as any).navigateTo = async () => { navigated += 1; };
  (t as any).ensureDocked = async () => {};
  (t as any).redirectBelowFloor = async () => false;
  if (o.pinned) (t as any).manualLegSkipsLossFloor = () => true;
  (t as any).heldCost.set("GRAVITON_EMITTERS", 33_785);
  (t as any).heldRoute.set("GRAVITON_EMITTERS", { good: "GRAVITON_EMITTERS", buyAt: "X1-Q-B1", sellAt: "X1-Q-A1", buyPrice: 33_785, sellPrice: 58_000, lotSize: 18 });
  return { t, logs, navigated: () => navigated };
}

describe("the destination check at the real delivery step", () => {
  it("holds instead of flying when the fresh stored bid has collapsed, and says why", async () => {
    const h = setup({ sellPrice: 25_731, ageMin: 4 });
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 0, "no jumps or fuel spent on a cargo that would sell at a loss");
    assert.match(h.logs.join("\n"), /holding 40u GRAVITON_EMITTERS .*not flying to X1-Q-A1: destination bids 25,731c/);
  });

  it("flies when the bid still pays", async () => {
    const h = setup({ sellPrice: 58_294, ageMin: 4 });
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 1);
  });

  it("ignores a reading older than 20 minutes (today's behaviour: fly, and the loss floor judges on arrival)", async () => {
    const h = setup({ sellPrice: 25_731, ageMin: 45 });
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 1);
  });

  it("with no reading at all it flies", async () => {
    const h = setup(undefined);
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 1);
  });

  it("with the buy guards off (impact 0) it flies", async () => {
    const h = setup({ sellPrice: 25_731, ageMin: 4 }, { impact: 0 });
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 1);
  });

  it("an operator's manual leg is not second-guessed", async () => {
    const h = setup({ sellPrice: 25_731, ageMin: 4 }, { pinned: true });
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 1);
  });

  it("looks again only every 5 minutes: three ticks, one decision, still held", async () => {
    const h = setup({ sellPrice: 25_731, ageMin: 4 });
    await (h.t as any).deliverHeldCargo(); await (h.t as any).deliverHeldCargo(); await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 0);
    assert.equal(h.logs.filter((l) => /not flying to/.test(l)).length, 1, "said once, not every tick");
  });

  it("a hold ends after 45 minutes and the cargo goes (the loss floor on arrival takes over)", async () => {
    const h = setup({ sellPrice: 25_731, ageMin: 4 });
    await (h.t as any).deliverHeldCargo();
    (h.t as any).sinkPreflightHeldSince.set("GRAVITON_EMITTERS", Date.now() - 46 * 60_000);
    (h.t as any).sinkPreflightAt.set("GRAVITON_EMITTERS", 0);
    await (h.t as any).deliverHeldCargo();
    assert.equal(h.navigated(), 1);
    assert.match(h.logs.join("\n"), /still not worth flying to X1-Q-A1 after 46 min, going anyway/);
  });
});
