import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockGood, blockedSet, normalizeGood, parseBlocked, unblockGood } from "../src/engine/blockedGoods.js";

const AT = "2026-10-22T12:00:00Z";

describe("blocked goods list", () => {
  it("normalises a trade symbol and rejects what cannot be one", () => {
    assert.equal(normalizeGood(" viral agents "), "VIRAL_AGENTS");
    assert.equal(normalizeGood("fab-mats"), "FAB_MATS");
    assert.equal(normalizeGood("x; drop"), undefined);
    assert.equal(normalizeGood(""), undefined);
  });
  it("blocks once, keeps the first time, and updates the reason", () => {
    const a = blockGood([], "viral_agents", AT, "thin market");
    assert.deepEqual(a, [{ good: "VIRAL_AGENTS", at: AT, reason: "thin market" }]);
    const b = blockGood(a, "VIRAL_AGENTS", "2026-10-23T00:00:00Z", "still bad");
    assert.equal(b.length, 1);
    assert.equal(b[0]!.at, AT);
    assert.equal(b[0]!.reason, "still bad");
    assert.throws(() => blockGood([], "no good!", AT), /not a trade symbol/);
  });
  it("unblocks, and unblocking something not listed changes nothing", () => {
    const a = blockGood(blockGood([], "A_B", AT), "C_D", AT);
    assert.deepEqual(unblockGood(a, "a_b").map((e) => e.good), ["C_D"]);
    assert.deepEqual(unblockGood(a, "NOPE").map((e) => e.good), ["A_B", "C_D"]);
  });
  it("round-trips through JSON and survives bad data", () => {
    const a = blockGood([], "VIRAL_AGENTS", AT, "r");
    assert.deepEqual(parseBlocked(JSON.stringify(a)), a);
    assert.deepEqual(parseBlocked("not json"), []);
    assert.deepEqual(parseBlocked(JSON.stringify([{ good: "ok_one" }, { good: 5 }, null])).map((e) => e.good), ["OK_ONE"]);
    assert.deepEqual(parseBlocked(undefined), []);
    assert.deepEqual([...blockedSet(a)], ["VIRAL_AGENTS"]);
  });
});

import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";

function traderWith(blocked: Set<string>): TraderAgent {
  const ship = {
    symbol: "T-1",
    nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-M1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  const a = new TraderAgent(ship, {
    api: { getCallCount: () => 0, getShip: async () => ship } as any,
    log: () => {},
    blockedGoods: () => blocked,
  } as any);
  const t = (a as any).priceTable as Map<string, Map<string, any>>;
  for (const good of ["VIRAL_AGENTS", "MEDICINE"]) {
    t.set("X1-A-M1", new Map([...(t.get("X1-A-M1") ?? []), [good, { buy: 100, sell: 90, volume: 40 }]]));
    t.set("X1-A-M2", new Map([...(t.get("X1-A-M2") ?? []), [good, { buy: 950, sell: 900, volume: 40 }]]));
  }
  (a as any).distBetween = () => 10;
  (a as any).getCredits = () => 10_000_000;
  return a;
}

describe("a trader and a blocked good", () => {
  const leg = (good: string) => ({ good, role: "direct" as const, buyAt: "X1-A-M1", sellAt: "X1-A-M2", buyPrice: 100, sellPrice: 900 });

  it("never takes a route in a blocked good, and still takes the same route in another good", () => {
    const a = traderWith(new Set(["VIRAL_AGENTS"]));
    assert.equal((a as any).viableRoute(leg("VIRAL_AGENTS")), undefined);
    assert.ok((a as any).viableRoute(leg("MEDICINE")));
    assert.match((a as any).whyNotViable(leg("VIRAL_AGENTS")), /blocked by the operator: VIRAL_AGENTS/);
  });

  it("its own free choice skips the blocked good", () => {
    const a = traderWith(new Set(["VIRAL_AGENTS"]));
    const r = (a as any).freeChoice();
    assert.ok(r);
    assert.equal(r.good, "MEDICINE");
    const none = traderWith(new Set(["VIRAL_AGENTS", "MEDICINE"]));
    assert.equal((none as any).freeChoice(), undefined);
  });

  it("an empty block list changes nothing", () => {
    assert.ok((traderWith(new Set()) as any).viableRoute(leg("VIRAL_AGENTS")));
  });
});

describe("FleetManager blocked goods", () => {
  it("persists the list, feeds the traders' cache, and unblocks", async () => {
    const fleet: any = new FleetManager({ api: {} as any });
    const flags = new Map<string, string>();
    fleet.tenantId = "t1";
    fleet.store = {
      getFleetFlag: async (_t: string, k: string) => flags.get(k),
      setFleetFlag: async (_t: string, k: string, v: string) => { flags.set(k, v); },
      removeFleetFlag: async (_t: string, k: string) => { flags.delete(k); },
    };
    await fleet.blockGood("viral agents", "thin market");
    assert.deepEqual([...fleet.blockedGoodsCache], ["VIRAL_AGENTS"]);
    assert.equal(JSON.parse(flags.get("blockedGoods")!)[0].reason, "thin market");
    assert.deepEqual((await fleet.blockedGoodsEntries()).map((e: any) => e.good), ["VIRAL_AGENTS"]);
    await fleet.unblockGood("VIRAL_AGENTS");
    assert.equal(fleet.blockedGoodsCache.size, 0);
    assert.equal(flags.has("blockedGoods"), false, "an empty list removes the flag");
    await assert.rejects(() => fleet.blockGood("not a good!"), /not a trade symbol/);
  });
});
