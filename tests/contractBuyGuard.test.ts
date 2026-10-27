import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contractBuyVerdict, NO_CONTRACT_BUY_GUARD } from "../src/engine/contractBuyGuard.js";
import { ContractManager } from "../src/engine/contract.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";

/**
 * 2026-10-25: 20 FOOD bought at 4,666c each (93k, nearly all the cash) for a contract that still owed 179,405c for 64 units
 * (2,803c a unit). The guard compared the live price only with the dispatcher's snapshot. These pin the rules.
 */
const POLICY = { priceGuardPct: 110, cashSharePct: 50 };

describe("contractBuyVerdict", () => {
  it("blocks the price that drained the cash: 4,666c against a contract paying 2,803c a unit", () => {
    const v = contractBuyVerdict({ buyPrice: 4666, remainingUnits: 64, remainingPayout: 179405, spendable: 88000 }, POLICY);
    assert.equal(v.blocked, true);
    assert.match(v.reason, /4,666c a unit is over the ceiling of 3,084c/);
  });

  it("allows the price the same contract is now offered at (1,275c)", () => {
    const v = contractBuyVerdict({ buyPrice: 1275, remainingUnits: 44, remainingPayout: 179405, spendable: 88000 }, POLICY);
    assert.equal(v.blocked, false);
  });

  it("measures against what is still owed per unit still needed, so a half-delivered contract pays more per remaining unit", () => {
    // 44 units left of the 179,405c: 4,077c a unit, so 4,666c is within 115% but over 110%; and 4,400c is fine.
    assert.equal(contractBuyVerdict({ buyPrice: 4666, remainingUnits: 44, remainingPayout: 179405, spendable: 90000 }, POLICY).blocked, true);
    assert.equal(contractBuyVerdict({ buyPrice: 4400, remainingUnits: 44, remainingPayout: 179405, spendable: 90000 }, POLICY).blocked, false);
  });

  it("limits one purchase to a share of the spendable cash", () => {
    const v = contractBuyVerdict({ buyPrice: 1000, remainingUnits: 100, remainingPayout: 500000, spendable: 40000 }, POLICY);
    assert.equal(v.blocked, false);
    assert.equal(v.maxUnits, 20, "50% of 40,000c at 1,000c a unit");
  });

  it("always allows one unit when one is affordable, and none when it is not", () => {
    assert.equal(contractBuyVerdict({ buyPrice: 1000, remainingUnits: 100, remainingPayout: 500000, spendable: 1500 }, POLICY).maxUnits, 1);
    assert.equal(contractBuyVerdict({ buyPrice: 1000, remainingUnits: 100, remainingPayout: 500000, spendable: 900 }, POLICY).maxUnits, 0);
  });

  it("does nothing without the facts it needs, or with both rules off (today's behaviour)", () => {
    const f = { buyPrice: 9999, remainingUnits: 0, remainingPayout: 0, spendable: 100 };
    assert.equal(contractBuyVerdict(f, POLICY).blocked, false, "no payout known: no price rule");
    const off = contractBuyVerdict({ buyPrice: 4666, remainingUnits: 64, remainingPayout: 179405, spendable: 88000 }, NO_CONTRACT_BUY_GUARD);
    assert.equal(off.blocked, false);
    assert.equal(off.maxUnits, Number.POSITIVE_INFINITY);
  });
});

describe("ContractManager.outstandingRewardFor", () => {
  function manager(contracts: unknown[]) {
    const m = new ContractManager({ api: {} } as never);
    (m as never as { listActive: () => Promise<unknown[]> }).listActive = async () => contracts;
    return m;
  }
  const contract = (id: string, onFulfilled: number, lines: [string, number, number][]) => ({
    id, accepted: true,
    terms: { deadline: "2026-11-01T00:00:00Z", payment: { onAccepted: 0, onFulfilled: onFulfilled }, deliver: lines.map(([tradeSymbol, unitsRequired, unitsFulfilled]) => ({ tradeSymbol, destinationSymbol: "X1-A-A1", unitsRequired, unitsFulfilled })) },
  });

  it("is the payment still owed over the units still needed", async () => {
    const r = await manager([contract("c1", 179405, [["FOOD", 64, 20]])]).outstandingRewardFor("FOOD");
    assert.equal(r.units, 44);
    assert.equal(Math.round(r.payout), 179405);
  });

  it("shares one contract's payment between its lines by units still needed", async () => {
    const r = await manager([contract("c1", 100000, [["FOOD", 30, 0], ["IRON", 70, 0]])]).outstandingRewardFor("FOOD");
    assert.equal(r.units, 30);
    assert.equal(Math.round(r.payout), 30000);
  });

  it("is zero for a good no contract wants", async () => {
    assert.deepEqual(await manager([contract("c1", 1000, [["FOOD", 5, 0]])]).outstandingRewardFor("GOLD"), { units: 0, payout: 0 });
  });
});

describe("the trader's contract buy uses the guard", () => {
  function trader(opts: { price: number; guard: boolean; credits?: number; approval?: boolean | undefined | "none" }) {
    const logs: string[] = [];
    const bought: number[] = [];
    const asked: string[] = [];
    const ship = {
      symbol: "T-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
      cargo: { capacity: 40, units: 0, inventory: [] },
      fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const agent = new TraderAgent(ship, {
      api: {
        getCallCount: () => 0, getShip: async () => ship, getMyAgent: async () => ({ credits: opts.credits ?? 100_000 }),
        purchaseCargo: async (_s: string, _g: string, units: number) => {
          bought.push(units);
          return { cargo: { capacity: 40, units, inventory: [] }, transaction: { pricePerUnit: opts.price, totalPrice: opts.price * units } };
        },
      },
      log: (m: string) => logs.push(m),
      contractNeeded: async () => 64,
      ...(opts.approval !== "none" && "approval" in opts ? { requestApproval: async (kind: string, o: { detail: string }) => { asked.push(`${kind}|${o.detail}`); return opts.approval as boolean | undefined; } } : {}),
      ...(opts.guard ? {
        contractReward: async () => ({ units: 64, payout: 179405 }),
        contractBuyPolicy: () => POLICY,
      } : {}),
    } as never);
    let toured = 0;
    const a = agent as never as Record<string, unknown>;
    a.discoverPrices = async () => { toured += 1; return true; };
    let traded = 0;
    a.runArbitrage = async () => { traded += 1; return true; };
    a.navigateTo = async () => {};
    a.ensureDocked = async () => {};
    a.liveBuyPrice = async () => opts.price;
    return { logs, bought, asked, traded: () => traded, toured: () => toured, run: () => (agent as never as { runContractBuy(x: unknown): Promise<boolean> }).runContractBuy({ shipSymbol: "T-1", good: "FOOD", role: "contractBuy", buyAt: "X1-A-A1", buyPrice: opts.price, source: "auto" }) };
  }

  it("refuses to buy at a price the contract cannot repay, logs why, and looks for another source", async () => {
    const t = trader({ price: 4666, guard: true });
    await t.run();
    assert.deepEqual(t.bought, [], "nothing bought");
    assert.equal(t.traded(), 1, "it earns instead of shuttling between markets for a price that may never come");
    assert.match(t.logs.join("\n"), /skipping contract buy: FOOD.*over the ceiling of 3,084c/);
  });

  it("asks the operator when over the ceiling, and trades while the question is open", async () => {
    const t = trader({ price: 4666, guard: true, approval: undefined });
    await t.run();
    assert.equal(t.asked.length, 1);
    assert.match(t.asked[0]!, /^contractBuyOverCeiling:FOOD\|.*4,666c|^contractBuyOverCeiling:FOOD\|.*over the ceiling of 3,084c/);
    assert.match(t.asked[0]!, /loss of about 119,/);
    assert.deepEqual(t.bought, []);
    assert.equal(t.traded(), 1);
    assert.match(t.logs.join("\n"), /waiting on the operator/);
  });

  it("buys the units still needed once the operator approves", async () => {
    const t = trader({ price: 4666, guard: true, approval: true });
    await t.run();
    assert.equal(t.bought.length, 1, "approved: one purchase goes through at the live price");
    assert.equal(t.traded(), 0);
    assert.match(t.logs.join("\n"), /operator approved buying FOOD at 4666c/);
  });

  it("trades and does not buy when the operator declines", async () => {
    const t = trader({ price: 4666, guard: true, approval: false });
    await t.run();
    assert.deepEqual(t.bought, []);
    assert.equal(t.traded(), 1);
    assert.match(t.logs.join("\n"), /operator declined/);
  });

  it("buys at a good price, but only up to its share of the cash", async () => {
    const t = trader({ price: 1275, guard: true, credits: 40_000 });
    await t.run();
    assert.deepEqual(t.bought, [15], "50% of 40,000c at 1,275c a unit");
  });

  it("without the guard the same purchase is made as before (today's behaviour)", async () => {
    const t = trader({ price: 4666, guard: false });
    await t.run();
    assert.equal(t.bought.length, 1);
    assert.equal(t.bought[0], 21, "spends what it can, as the 2026-10-25 purchase did");
  });
});
