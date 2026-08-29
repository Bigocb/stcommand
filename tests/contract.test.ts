import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractManager, type Contract } from "../src/engine/contract.js";

/**
 * Covers the behavior changed while closing the contract-goods-get-dumped
 * bug: protectedGoods() (previously didn't exist — contract goods had no
 * protection anywhere), and acceptBest()'s cost/deadline-aware scoring
 * (previously ranked by raw payout alone, with no feasibility check at
 * all). ContractManager had zero test coverage before this.
 */

function makeContract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    factionSymbol: "COSMIC",
    type: "PROCUREMENT",
    accepted: false,
    fulfilled: false,
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    terms: {
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      payment: { onAccepted: 1000, onFulfilled: 2000 },
      deliver: [],
    },
    ...overrides,
  } as Contract;
}

function makeApi(contracts: Contract[], opts?: { negotiated?: Contract }) {
  const accepted: string[] = [];
  const negotiatedFor: string[] = [];
  return {
    api: {
      getContracts: async () => contracts,
      acceptContract: async (id: string) => {
        accepted.push(id);
        const c = contracts.find((x) => x.id === id)!;
        c.accepted = true;
        return { agent: {}, contract: c };
      },
      fulfillContract: async () => {},
      deliverContract: async () => {},
      negotiateContract: async (shipSymbol: string) => {
        negotiatedFor.push(shipSymbol);
        if (!opts?.negotiated) throw new Error("no contract configured for this test's negotiateContract mock");
        contracts.push(opts.negotiated);
        return { contract: opts.negotiated };
      },
    } as any,
    accepted,
    negotiatedFor,
  };
}

describe("ContractManager.protectedGoods", () => {
  it("is empty when nothing is accepted", async () => {
    const { api } = makeApi([makeContract({ id: "c1" })]);
    const cm = new ContractManager(api);
    await cm.listActive(); // warms the cache protectedGoods() reads from
    assert.deepEqual(cm.protectedGoods(), new Set());
  });

  it("includes trade symbols from accepted contracts with outstanding delivery", async () => {
    const c = makeContract({
      id: "c1",
      accepted: true,
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 2000 },
        deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-A-A1", unitsRequired: 10, unitsFulfilled: 0 }],
      },
    });
    const { api } = makeApi([c]);
    const cm = new ContractManager(api);
    await cm.listActive();
    assert.deepEqual(cm.protectedGoods(), new Set(["IRON_ORE"]));
  });

  it("excludes a good that's already fully delivered", async () => {
    const c = makeContract({
      id: "c1",
      accepted: true,
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 2000 },
        deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-A-A1", unitsRequired: 10, unitsFulfilled: 10 }],
      },
    });
    const { api } = makeApi([c]);
    const cm = new ContractManager(api);
    await cm.listActive();
    assert.deepEqual(cm.protectedGoods(), new Set());
  });

  it("excludes a fulfilled contract even if it reports accepted", async () => {
    const c = makeContract({
      id: "c1",
      accepted: true,
      fulfilled: true,
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 2000 },
        deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-A-A1", unitsRequired: 10, unitsFulfilled: 0 }],
      },
    });
    const { api } = makeApi([c]);
    const cm = new ContractManager(api);
    await cm.listActive();
    assert.deepEqual(cm.protectedGoods(), new Set());
  });
});

describe("ContractManager.acceptBest", () => {
  it("skips a contract whose deadline is too tight to realistically fly", async () => {
    const tight = makeContract({
      id: "tight",
      terms: {
        deadline: new Date(Date.now() + 60_000).toISOString(), // 1 minute — well under the 15-minute floor
        payment: { onAccepted: 5000, onFulfilled: 5000 },
        deliver: [],
      },
    });
    const { api, accepted } = makeApi([tight]);
    const cm = new ContractManager(api);

    const result = await cm.acceptBest();

    assert.equal(result, undefined);
    assert.deepEqual(accepted, []);
  });

  it("with no store, ranks by raw payout (degrades gracefully with no market intel)", async () => {
    const low = makeContract({ id: "low", terms: { deadline: new Date(Date.now() + 3_600_000).toISOString(), payment: { onAccepted: 100, onFulfilled: 100 }, deliver: [] } });
    const high = makeContract({ id: "high", terms: { deadline: new Date(Date.now() + 3_600_000).toISOString(), payment: { onAccepted: 5000, onFulfilled: 5000 }, deliver: [] } });
    const { api, accepted } = makeApi([low, high]);
    const cm = new ContractManager(api);

    const result = await cm.acceptBest();

    assert.equal(result?.id, "high");
    assert.deepEqual(accepted, ["high"]);
  });

  it("prefers a lower-payout contract when the high-payout one costs more to source than it pays", async () => {
    const cheap = makeContract({
      id: "cheap",
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 1000 }, // net 2000
        deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-A-A1", unitsRequired: 10, unitsFulfilled: 0 }],
      },
    });
    const expensive = makeContract({
      id: "expensive",
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1500, onFulfilled: 1500 }, // net 3000, but costs 5000 to source
        deliver: [{ tradeSymbol: "PLATINUM", destinationSymbol: "X1-A-A1", unitsRequired: 10, unitsFulfilled: 0 }],
      },
    });
    const { api, accepted } = makeApi([cheap, expensive]);
    const store = {
      latestMarketSnapshots: async () => [
        { waypointSymbol: "X1-A-M1", goodSymbol: "IRON_ORE", purchasePrice: 10 } as any, // 10 * 10u = 100
        { waypointSymbol: "X1-A-M2", goodSymbol: "PLATINUM", purchasePrice: 500 } as any, // 500 * 10u = 5000
      ],
    };
    const cm = new ContractManager(api, store as any);

    const result = await cm.acceptBest();

    assert.equal(result?.id, "cheap");
    assert.deepEqual(accepted, ["cheap"]);
  });

  it("does not treat a good with no known market as unsourceable (e.g. a raw ore only ever mined)", async () => {
    const oreOnly = makeContract({
      id: "ore-only",
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 1000 },
        deliver: [{ tradeSymbol: "SILICON_CRYSTALS", destinationSymbol: "X1-A-A1", unitsRequired: 10, unitsFulfilled: 0 }],
      },
    });
    const { api, accepted } = makeApi([oreOnly]);
    const store = { latestMarketSnapshots: async () => [] }; // no market sells it
    const cm = new ContractManager(api, store as any);

    const result = await cm.acceptBest();

    assert.equal(result?.id, "ore-only", "an unpriceable good must not disqualify the contract");
    assert.deepEqual(accepted, ["ore-only"]);
  });

  it("ignores declined contracts", async () => {
    const c = makeContract({ id: "c1" });
    const { api, accepted } = makeApi([c]);
    const cm = new ContractManager(api);
    cm.decline("c1");

    const result = await cm.acceptBest();

    assert.equal(result, undefined);
    assert.deepEqual(accepted, []);
  });
});

describe("ContractManager.negotiate", () => {
  it("calls negotiateContract with the given ship and returns the new contract", async () => {
    const fresh = makeContract({ id: "new-1" });
    const { api, negotiatedFor } = makeApi([], { negotiated: fresh });
    const cm = new ContractManager(api);

    const result = await cm.negotiate("SHIP-1");

    assert.deepEqual(negotiatedFor, ["SHIP-1"]);
    assert.equal(result.id, "new-1");
  });

  it("invalidates the cache so the negotiated contract shows up immediately, not after the TTL", async () => {
    const fresh = makeContract({ id: "new-1" });
    const { api } = makeApi([], { negotiated: fresh });
    const cm = new ContractManager(api);

    await cm.listActive(); // warms the cache with the empty list
    await cm.negotiate("SHIP-1");
    const active = await cm.listActive();

    assert.deepEqual(
      active.map((c) => c.id),
      ["new-1"],
      "listActive() must reflect the negotiated contract right away, not the pre-negotiate cached snapshot",
    );
  });
});

describe("ContractManager dead-code cleanup", () => {
  it("wantsGood and deliverFromShip no longer exist (superseded by protectedGoods/deliverVia)", async () => {
    const { api } = makeApi([]);
    const cm = new ContractManager(api);
    assert.equal((cm as any).wantsGood, undefined);
    assert.equal((cm as any).deliverFromShip, undefined);
  });
});

describe("ContractManager.deliverVia", () => {
  it("docks an in-orbit ship at the destination before delivering, instead of failing the raw API call", async () => {
    // Confirmed live: FALCON-D navigated to a contract's delivery
    // destination, arrived, and sat there IN_ORBIT holding the cargo —
    // deliverVia() called api.deliverContract() straight away with no dock
    // check, and every retry failed identically with "Ship action failed.
    // Ship is not currently docked at X1-CP51-H61". Under the old blocking
    // tick() flow this never showed up because trader.ts's own
    // ensureDocked() ran in between navigating and delivering in the same
    // tick — but arrival is now picked up on a later, separate tick (the
    // scheduler-driven NavigationPending resume), whose very first action
    // is this call, before ensureDocked() ever gets a turn.
    const contract = makeContract({
      id: "c1",
      accepted: true,
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 2000 },
        deliver: [{ tradeSymbol: "SILVER", destinationSymbol: "X1-A-DEST", unitsRequired: 60, unitsFulfilled: 0 } as any],
      },
    });
    const { api } = makeApi([contract]);
    let docked = false;
    (api as any).dockShip = async () => { docked = true; };
    (api as any).getShipCargo = async () => ({ inventory: [{ symbol: "SILVER", units: 60 }] });
    let deliveredUnits: number | undefined;
    (api as any).deliverContract = async (_id: string, _ship: string, _good: string, units: number) => {
      if (!docked) throw new Error("Ship action failed. Ship is not currently docked at X1-A-DEST.");
      deliveredUnits = units;
    };
    const cm = new ContractManager(api);
    const ship = {
      symbol: "SHIP-1",
      nav: { waypointSymbol: "X1-A-DEST", status: "IN_ORBIT" },
      cargo: { inventory: [{ symbol: "SILVER", units: 60 }] },
    } as any;

    const result = await cm.deliverVia(ship);

    assert.equal(docked, true, "must dock the ship before attempting delivery");
    assert.equal(deliveredUnits, 60);
    assert.equal(result, true);
  });

  it("does not attempt to dock an already-docked ship", async () => {
    const contract = makeContract({
      id: "c1",
      accepted: true,
      terms: {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        payment: { onAccepted: 1000, onFulfilled: 2000 },
        deliver: [{ tradeSymbol: "SILVER", destinationSymbol: "X1-A-DEST", unitsRequired: 60, unitsFulfilled: 0 } as any],
      },
    });
    const { api } = makeApi([contract]);
    let dockCalled = false;
    (api as any).dockShip = async () => { dockCalled = true; };
    (api as any).getShipCargo = async () => ({ inventory: [{ symbol: "SILVER", units: 60 }] });
    (api as any).deliverContract = async () => {};
    const cm = new ContractManager(api);
    const ship = {
      symbol: "SHIP-1",
      nav: { waypointSymbol: "X1-A-DEST", status: "DOCKED" },
      cargo: { inventory: [{ symbol: "SILVER", units: 60 }] },
    } as any;

    await cm.deliverVia(ship);

    assert.equal(dockCalled, false, "an already-docked ship needs no extra dock call");
  });
});
