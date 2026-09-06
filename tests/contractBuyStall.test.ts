import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * The trader that shuttled for an hour without ever buying anything.
 *
 * DRAGOM-1 held a "contractBuy" assignment for DRUGS against a contract
 * paying 181,474c, with 5,497c in the bank. It could not afford a single
 * unit, so runContractBuy() computed units = 0 and returned
 * discoverPrices() — which tours a market, reports success, and changes
 * nothing about affordability. The dispatcher saw a busy ship and kept the
 * assignment; the fleet line called it idle; no log line anywhere said why
 * no purchase was happening. The loop ran every ~40 seconds:
 *
 *   discovering prices... -> docking -> orbit -> dock -> discovering prices...
 *
 * Every exit from that function was silent, which is why the cause could not
 * be read off two hours of logs. These pin both halves of the fix: each exit
 * names its reason, and the exits that touring cannot possibly resolve send
 * the ship to earn instead of orbit.
 */

function trader(opts: {
  credits: number;
  buyPrice: number;
  needed?: number;
  cargoUnits?: number;
  capacity?: number;
}) {
  const logs: string[] = [];
  const capacity = opts.capacity ?? 40;
  const ship = {
    symbol: "DRAGOM-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-S84-H56", systemSymbol: "X1-S84", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    cargo: { capacity, units: opts.cargoUnits ?? 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  const agent = new TraderAgent(ship, {
    api: {
      getCallCount: () => 0,
      getShip: async () => ship,
      getMyAgent: async () => ({ credits: opts.credits }),
      purchaseCargo: async () => { throw new Error("must not buy what it cannot afford"); },
    },
    log: (m: string) => logs.push(m),
    contractNeeded: async () => opts.needed ?? 100,
  } as never);
  // The two paths this function can fall back to. Stubbed so each test can
  // assert which one was taken without flying a real trip.
  let toured = 0;
  let traded = 0;
  (agent as never as Record<string, unknown>).discoverPrices = async () => { toured += 1; return true; };
  (agent as never as Record<string, unknown>).runArbitrage = async () => { traded += 1; return true; };
  (agent as never as Record<string, unknown>).navigateTo = async () => {};
  (agent as never as Record<string, unknown>).ensureDocked = async () => {};
  (agent as never as Record<string, unknown>).liveBuyPrice = async () => opts.buyPrice;
  return {
    agent,
    logs,
    counts: () => ({ toured, traded }),
    run: () =>
      (agent as never as { runContractBuy(a: unknown): Promise<boolean> }).runContractBuy({
        shipSymbol: "DRAGOM-1", good: "DRUGS", role: "contractBuy",
        buyAt: "X1-S84-H56", buyPrice: opts.buyPrice, source: "auto",
      }),
  };
}

describe("a contract buy that cannot happen says why, and stops orbiting", () => {
  it("goes trading when it cannot afford a single unit", async () => {
    // The live case: 5,497c against a good priced well above it.
    const t = trader({ credits: 5_497, buyPrice: 7_200 });
    await t.run();
    assert.equal(t.counts().traded, 1, "a ship that cannot afford its assignment should go and earn");
    assert.equal(t.counts().toured, 0, "touring markets cannot change what the ship can afford");
    assert.match(t.logs.join("\n"), /cannot afford one unit at 7200c with 5497c in hand/);
  });

  it("goes trading when the contract needs nothing more", async () => {
    const t = trader({ credits: 1_000_000, buyPrice: 100, needed: 0 });
    await t.run();
    assert.equal(t.counts().traded, 1);
    assert.equal(t.counts().toured, 0);
    assert.match(t.logs.join("\n"), /contract needs no more units/);
  });

  it("names a full hold rather than pretending to look for prices", async () => {
    const t = trader({ credits: 1_000_000, buyPrice: 100, cargoUnits: 40, capacity: 40 });
    await t.run();
    assert.deepEqual(t.counts(), { toured: 0, traded: 0 }, "neither touring nor trading fits a full hold");
    assert.match(t.logs.join("\n"), /hold is full/);
  });

  it("still tours when the problem really is a missing price", async () => {
    // The one case touring exists for — it must survive the fix.
    const t = trader({ credits: 1_000_000, buyPrice: 0 });
    await t.run();
    assert.equal(t.counts().toured, 1);
    assert.match(t.logs.join("\n"), /no price known at X1-S84-H56, touring to find one/);
  });

  it("buys normally when it can actually afford the good", async () => {
    // The control: none of the new exits may block a purchase that should happen.
    const t = trader({ credits: 1_000_000, buyPrice: 100, needed: 5 });
    await assert.rejects(t.run(), /must not buy what it cannot afford/, "reached purchaseCargo, which is the success path here");
    assert.deepEqual(t.counts(), { toured: 0, traded: 0 });
  });
});
