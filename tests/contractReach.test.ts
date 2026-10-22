import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_DELIVERY_BACKOFF_MS, isNoGatePathError } from "../src/engine/contractReach.js";
import { ContractManager, type Contract } from "../src/engine/contract.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-10-22: a contract for 132 PRECIOUS_STONES delivering to X1-NH60-ZA5E (21 jumps from home, owing 17k) was accepted and
 * sourced; THEOREM-21 bought 40 and failed "no verified gate path (<= 10 hops)" every 12 s for over two hours.
 */
describe("contractReach (pure)", () => {
  it("recognises the errors a trader throws when a destination has no gate path", () => {
    assert.equal(isNoGatePathError(new Error("no verified gate path (<= 10 hops) from X1-YM69 to X1-NH60")), true);
    assert.equal(isNoGatePathError(new Error("no jump gate from X1-A to X1-B")), true);
    assert.equal(isNoGatePathError(new Error("X1-B has no jump gate waypoint")), true);
    assert.equal(isNoGatePathError(new Error("Ship is currently in-transit")), false);
    assert.equal(isNoGatePathError("socket hang up"), false);
  });
  it("leaves a delivery alone for half an hour", () => {
    assert.equal(CONTRACT_DELIVERY_BACKOFF_MS, 30 * 60_000);
  });
});

function contract(id: string, dest: string, onFulfilled: number): Contract {
  const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();
  return {
    id, factionSymbol: "COSMIC", type: "PROCUREMENT", accepted: false, fulfilled: false, expiration: deadline,
    terms: { deadline, payment: { onAccepted: 1000, onFulfilled }, deliver: [{ tradeSymbol: "PRECIOUS_STONES", destinationSymbol: dest, unitsRequired: 100, unitsFulfilled: 0 }] },
  } as Contract;
}
function manager(contracts: Contract[], reachable?: (dest: string) => boolean) {
  const accepted: string[] = [];
  const cm = new ContractManager({
    getContracts: async () => contracts,
    acceptContract: async (id: string) => { accepted.push(id); const c = contracts.find((x) => x.id === id)!; c.accepted = true; return { agent: {}, contract: c }; },
  } as any);
  if (reachable) cm.setDeliveryReachable(async (d) => reachable(d));
  return { cm, accepted };
}

describe("ContractManager.acceptBest and unreachable delivery points", () => {
  const far = () => contract("far", "X1-NH60-ZA5E", 50_000);
  const near = () => contract("near", "X1-HOME-A1", 20_000);
  const reach = (d: string) => d.startsWith("X1-HOME");

  it("passes over a contract it cannot deliver, even when it pays more, and takes the one it can", async () => {
    const { cm, accepted } = manager([far(), near()], reach);
    assert.equal((await cm.acceptBest())?.id, "near");
    assert.deepEqual(accepted, ["near"]);
  });
  it("accepts nothing when every offer is unreachable", async () => {
    const { cm, accepted } = manager([far()], reach);
    assert.equal(await cm.acceptBest(), undefined);
    assert.deepEqual(accepted, []);
  });
  it("behaves as before when reachability is not known", async () => {
    const { cm, accepted } = manager([far(), near()]);
    assert.equal((await cm.acceptBest())?.id, "far");
    assert.deepEqual(accepted, ["far"]);
  });
});

describe("FleetManager sourcing and the delivery-reachability check", () => {
  function fleet(jumpPath: (a: string, b: string) => string[] | undefined, warm: (a: string, b: string) => string[] | undefined = () => undefined) {
    const f: any = new FleetManager({ api: {} as any });
    f.systemSymbol = "X1-HOME";
    f.log = () => {};
    const calls = { warm: 0 };
    f.galaxy = { canJump: () => false, jumpPath, warmJumpPath: async (a: string, b: string) => { calls.warm++; return warm(a, b); }, maxPositioningHops: 10 };
    return { f, calls };
  }
  it("a destination with a verified path is reachable, and the answer is remembered", async () => {
    const { f, calls } = fleet((a, b) => [a, b]);
    assert.equal(await f.contractDestinationReachable("X1-NEAR-A1"), true);
    assert.equal(await f.contractDestinationReachable("X1-NEAR-A1"), true);
    assert.equal(calls.warm, 0);
  });
  it("a destination in the home system needs no path", async () => {
    const { f } = fleet(() => undefined);
    assert.equal(await f.contractDestinationReachable("X1-HOME-B2"), true);
  });
  it("an unverified path is looked for once before it counts as unreachable, then remembered", async () => {
    const { f, calls } = fleet(() => undefined);
    assert.equal(await f.contractDestinationReachable("X1-NH60-ZA5E"), false);
    assert.equal(await f.contractDestinationReachable("X1-NH60-ZA5E"), false);
    assert.equal(calls.warm, 1);
  });
  it("a path found only after warming the gates is reachable", async () => {
    const { f } = fleet(() => undefined, (a, b) => [a, "X1-MID", b]);
    assert.equal(await f.contractDestinationReachable("X1-FAR-A1"), true);
  });
  it("stops sourcing a contract good whose delivery point is unreachable, and sources one that is reachable", async () => {
    const { f } = fleet((a, b) => (b === "X1-NEAR" ? [a, b] : undefined));
    f.contracts = { outstandingDeliveries: async () => [
      { contractId: "c1", tradeSymbol: "PRECIOUS_STONES", destinationSymbol: "X1-NH60-ZA5E", unitsRequired: 132, unitsFulfilled: 0, onFulfilledPayment: 11_000 },
      { contractId: "c2", tradeSymbol: "IRON_ORE", destinationSymbol: "X1-NEAR-A1", unitsRequired: 50, unitsFulfilled: 0, onFulfilledPayment: 9_000 },
    ] };
    f.materialBuyers = async () => [{ waypoint: "X1-HOME-M1", purchasePrice: 50 }];
    const targets = await f.computeContractBuyTargets();
    assert.deepEqual(targets.map((t: any) => t.good), ["IRON_ORE"]);
  });
});

describe("a loaded trader whose contract delivery point has no gate path", () => {
  function trader(navigate: () => Promise<void>) {
    const ship = {
      symbol: "T-21", nav: { status: "DOCKED", waypointSymbol: "X1-YM69-J66", systemSymbol: "X1-YM69", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 40, units: 40, inventory: [{ symbol: "PRECIOUS_STONES", units: 40 }] },
      fuel: { current: 300, capacity: 300 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const logs: string[] = [];
    const a = new TraderAgent(ship, { api: { getCallCount: () => 0, getShip: async () => ship } as any, log: (m: string) => logs.push(m) } as any) as any;
    a.navigateTo = navigate;
    a.refresh = async () => {};
    return { a, logs };
  }
  const noPath = async () => { throw new Error("no verified gate path (<= 10 hops) from X1-YM69 to X1-NH60"); };

  it("backs the delivery off and lets the tick go on, instead of erroring every tick", async () => {
    const { a, logs } = trader(noPath);
    assert.equal(a.contractDeliveryBackedOff(), false);
    assert.equal(await a.deliverContractCargo("X1-NH60-ZA5E"), false, "false = carry on with the rest of the tick");
    assert.equal(a.contractDeliveryBackedOff(), true);
    assert.ok(logs.some((l) => /leaving it for 30 min/.test(l)));
  });
  it("tries again once the half hour has passed", async () => {
    const { a } = trader(noPath);
    await a.deliverContractCargo("X1-NH60-ZA5E");
    const real = Date.now;
    try {
      Date.now = () => real() + CONTRACT_DELIVERY_BACKOFF_MS + 1_000;
      assert.equal(a.contractDeliveryBackedOff(), false);
    } finally { Date.now = real; }
  });
  it("still delivers normally when the path is fine, and rethrows any other error", async () => {
    const ok = trader(async () => {});
    assert.equal(await ok.a.deliverContractCargo("X1-NH60-ZA5E"), true);
    assert.equal(ok.a.contractDeliveryBackedOff(), false);
    const broken = trader(async () => { throw new Error("socket hang up"); });
    await assert.rejects(() => broken.a.deliverContractCargo("X1-NH60-ZA5E"), /socket hang up/);
  });
});
