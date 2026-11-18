import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tradeBudget, tradeBudgetReason } from "../src/engine/tradeBudget.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";

describe("tradeBudget (cash floor for cargo, 2026-11-18)", () => {
  it("share 0 is the old rule: wallet less the floor, never negative", () => {
    assert.equal(tradeBudget(250_000, 100_000, 0), 150_000);
    assert.equal(tradeBudget(31_140, 100_000, 0), 0);
  });
  it("below the floor a share of the wallet may still be spent on cargo", () => {
    assert.equal(tradeBudget(31_140, 100_000, 50), 15_570);
    assert.equal(tradeBudget(86, 100_000, 50), 43);
  });
  it("well above the floor the floor rule is the larger and wins", () => {
    assert.equal(tradeBudget(1_000_000, 100_000, 50), 900_000);
  });
  it("between one and two floors the share keeps half the wallet in reserve", () => {
    assert.equal(tradeBudget(150_000, 100_000, 50), 75_000);
  });
  it("bad inputs read as nothing to spend", () => {
    assert.equal(tradeBudget(NaN, 100_000, 50), 0);
    assert.equal(tradeBudget(-5, 100_000, 50), 0);
  });
  it("explains itself", () => {
    assert.match(tradeBudgetReason(31_140, 100_000, 50), /50% of a 31140 wallet/);
    assert.match(tradeBudgetReason(1_000_000, 100_000, 50), /wallet less the 100000 floor/);
  });
});

describe("the fleet gives traders the trade budget, other buyers the full floor", () => {
  it("traderOptions credits use the share below the floor; spendableCredits does not", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    fleet.credits = 31_140;
    fleet.doctrine.value = (k: string, d?: number) => (k === "cashFloor" ? 100_000 : k === "cashFloorTradeSharePct" ? 50 : (d ?? 0));
    fleet.doctrine.isEnabledOr = (k: string, d: boolean) => (k === "cashFloorTradeSharePct" ? true : d);
    assert.equal(fleet.spendableCredits(), 0);
    assert.equal(fleet.traderOptions("THEO-1").getCredits(), 15_570);
    assert.equal(fleet.traderOptions("THEO-1").applyCashFloor(31_140), 15_570);
  });
  it("with the clause off traders keep the full floor (the old rule)", () => {
    const fleet: any = new FleetManager({ api: {} as any });
    fleet.credits = 31_140;
    fleet.doctrine.value = (k: string, d?: number) => (k === "cashFloor" ? 100_000 : (d ?? 0));
    fleet.doctrine.isEnabledOr = (_k: string, d: boolean) => d && false;
    assert.equal(fleet.traderOptions("THEO-1").getCredits(), 0);
  });
});

describe("a trader with no route waits instead of discovering (traderIdleDiscovery off)", () => {
  function trader(idle: boolean | undefined) {
    const ship = {
      symbol: "T-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const a: any = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship } as any,
      log: () => {},
      assignedRoute: () => undefined,
      claimRoute: () => undefined,
      idleDiscovery: idle === undefined ? undefined : () => idle,
    } as any);
    let discovered = 0;
    a.discoverPrices = async () => { discovered++; return true; };
    return { a, discovered: () => discovered };
  }
  it("off: no discovery, reports no progress", async () => {
    const { a, discovered } = trader(false);
    assert.equal(await a.runArbitrage(undefined), false);
    assert.equal(discovered(), 0);
  });
  it("on: discovers as before", async () => {
    const { a, discovered } = trader(true);
    assert.equal(await a.runArbitrage(undefined), true);
    assert.equal(discovered(), 1);
  });
  it("not wired (standalone trader): discovers as before", async () => {
    const { a, discovered } = trader(undefined);
    assert.equal(await a.runArbitrage(undefined), true);
    assert.equal(discovered(), 1);
  });
});
