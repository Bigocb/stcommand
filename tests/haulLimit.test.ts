import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { haulLegVerdict, withinHaulLimit } from "../src/engine/haulLimit.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";

describe("haulLimit (pure)", () => {
  it("allows any length when there is no limit, and anything within it", () => {
    assert.deepEqual(haulLegVerdict(10, undefined), { ok: true });
    assert.deepEqual(haulLegVerdict(4, 4), { ok: true });
    assert.deepEqual(haulLegVerdict(1, 4), { ok: true });
  });
  it("refuses a leg over the limit and says how long it is", () => {
    const v = haulLegVerdict(9, 4);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /9 gate jumps.*limit of 4/);
  });
  it("withinHaulLimit: no path is never within, no limit always is", () => {
    assert.equal(withinHaulLimit(undefined, 4), false);
    assert.equal(withinHaulLimit(undefined, undefined), false);
    assert.equal(withinHaulLimit(9, undefined), true);
    assert.equal(withinHaulLimit(5, 4), false);
    assert.equal(withinHaulLimit(4, 4), true);
  });
});

describe("FleetManager leg filter (hauledHops clause)", () => {
  const fleet = (on: boolean, limit: number, hops: number) => {
    const f = new FleetManager({ api: {} as any }) as any;
    f.doctrine = { isEnabledOr: (k: string) => (k === "hauledHops" ? on : true), value: (k: string, d?: number) => (k === "hauledHops" ? limit : d ?? 0) };
    f.crossSystemHops = () => hops;
    return f;
  };
  it("clause off: a ten-jump leg is offered, as before", () => {
    assert.equal(fleet(false, 4, 10).haulLegRefusal("X1-A", "X1-B"), undefined);
  });
  it("clause on: a leg over the limit is refused with a reason, one within it is not", () => {
    assert.match(fleet(true, 4, 10).haulLegRefusal("X1-A", "X1-B"), /10 gate jumps/);
    assert.equal(fleet(true, 4, 3).haulLegRefusal("X1-A", "X1-B"), undefined);
  });
  it("a same-system leg is never refused", () => {
    assert.equal(fleet(true, 1, 99).haulLegRefusal("X1-A", "X1-A"), undefined);
  });
});

describe("a loaded trader turned back from its destination (redirectUnreachable)", () => {
  function trader(limit: number | undefined) {
    const ship = {
      symbol: "T-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-G1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 225, units: 225, inventory: [{ symbol: "MACHINERY", units: 225 }] },
      fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const a = new TraderAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: () => {}, redirectHops: () => limit } as any) as any;
    const hops: Record<string, number> = { "X1-NEAR": 2, "X1-FAR": 9 };
    a.positioningPath = (_from: string, to: string) => (hops[to] === undefined ? undefined : Array.from({ length: hops[to]! + 1 }, (_, i) => `S${i}`));
    a.costBasis = async () => 2000;
    a.priceTable.set("X1-NEAR-M1", new Map([["MACHINERY", { buy: 3000, sell: 2900, volume: 40 }]]));
    a.priceTable.set("X1-FAR-M1", new Map([["MACHINERY", { buy: 3500, sell: 3400, volume: 40 }]]));
    a.heldRoute.set("MACHINERY", { good: "MACHINERY", buyAt: "X1-A-B1", sellAt: "X1-TK-D39C", buyPrice: 2150, sellPrice: 3320, lotSize: 40 });
    return a;
  }
  it("no limit: takes the best price, however far (today's behaviour)", async () => {
    const a = trader(undefined);
    await a.redirectUnreachable("MACHINERY");
    assert.equal(a.heldRoute.get("MACHINERY").sellAt, "X1-FAR-M1");
  });
  it("limit 4: takes the market two jumps away rather than the better price nine jumps away", async () => {
    const a = trader(4);
    await a.redirectUnreachable("MACHINERY");
    assert.equal(a.heldRoute.get("MACHINERY").sellAt, "X1-NEAR-M1");
  });
  it("limit 1 and nothing that close: still redirects, to the reachable market", async () => {
    const a = trader(1);
    await a.redirectUnreachable("MACHINERY");
    assert.match(a.heldRoute.get("MACHINERY").sellAt, /X1-(NEAR|FAR)-M1/);
  });
});
