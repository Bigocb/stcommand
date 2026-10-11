import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractManager, type Contract } from "../src/engine/contract.js";

/**
 * A contract's money, row by row: the advance on accept, each delivery with its cost basis, and the payout on completion, every
 * one tied to the contract it belongs to (migrations/049). Before this only the payout was recorded, with no contract id.
 */
const DEST = "X1-A-DEST";
const hour = () => new Date(Date.now() + 3_600_000).toISOString();

function contract(over: Partial<Contract> & { id: string }): Contract {
  return {
    factionSymbol: "COSMIC", type: "PROCUREMENT", accepted: false, fulfilled: false, expiration: hour(), deadlineToAccept: hour(),
    terms: {
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      payment: { onAccepted: 3107, onFulfilled: 7607 },
      deliver: [{ tradeSymbol: "POLYNUCLEOTIDES", destinationSymbol: DEST, unitsRequired: 22, unitsFulfilled: 0 }],
    },
    ...over,
  } as Contract;
}

type Row = { type: string; total: number; tradeSymbol?: string; units?: number; pricePerUnit?: number; contractId?: string; shipSymbol: string };

function harness(contracts: Contract[], costBasis?: number) {
  const ledger: Row[] = [];
  const api = {
    getContracts: async () => contracts,
    acceptContract: async (id: string) => { const c = contracts.find((x) => x.id === id)!; c.accepted = true; },
    dockShip: async () => {},
    fulfillContract: async () => {},
    getShipCargo: async () => ({ capacity: 40, units: 22, inventory: [{ symbol: "POLYNUCLEOTIDES", units: 22 }] }),
    deliverContract: async () => {},
  } as never;
  const cm = new ContractManager(api, undefined, undefined, {
    recordLedger: (e) => ledger.push(e as Row),
    costBasisOf: costBasis === undefined ? undefined : async () => costBasis,
  });
  return { cm, ledger };
}

const shipAt = (waypoint: string) => ({
  symbol: "THEOREM-A", nav: { waypointSymbol: waypoint, status: "DOCKED", systemSymbol: "X1-A" },
  cargo: { capacity: 40, units: 22, inventory: [{ symbol: "POLYNUCLEOTIDES", units: 22 }] },
}) as never;

describe("contract ledger rows", () => {
  it("accepting records the advance, tied to the contract", async () => {
    const { cm, ledger } = harness([contract({ id: "c1" })]);
    await cm.acceptBest();
    assert.equal(ledger.length, 1);
    assert.deepEqual({ type: ledger[0]!.type, tradeSymbol: ledger[0]!.tradeSymbol, total: ledger[0]!.total, contractId: ledger[0]!.contractId }, { type: "CONTRACT", tradeSymbol: "ADVANCE", total: 3107, contractId: "c1" });
  });

  it("accepting by id records it too, and an already-accepted contract records nothing", async () => {
    const { cm, ledger } = harness([contract({ id: "c1" }), contract({ id: "c2", accepted: true })]);
    await cm.acceptById("c1");
    await cm.acceptById("c2");
    assert.deepEqual(ledger.map((r) => r.contractId), ["c1"]);
  });

  it("a contract with no advance records no advance row", async () => {
    const c = contract({ id: "c1" });
    (c.terms.payment as { onAccepted: number }).onAccepted = 0;
    const { cm, ledger } = harness([c]);
    await cm.acceptBest();
    assert.deepEqual(ledger, []);
  });

  it("a delivery records units, cost basis and the contract, with total 0 (it is not cash)", async () => {
    const { cm, ledger } = harness([contract({ id: "c1", accepted: true })], 285);
    await cm.deliverVia(shipAt(DEST));
    assert.equal(ledger.length, 1);
    const r = ledger[0]!;
    assert.deepEqual({ type: r.type, tradeSymbol: r.tradeSymbol, units: r.units, pricePerUnit: r.pricePerUnit, total: r.total, contractId: r.contractId, shipSymbol: r.shipSymbol },
      { type: "DELIVERY", tradeSymbol: "POLYNUCLEOTIDES", units: 22, pricePerUnit: 285, total: 0, contractId: "c1", shipSymbol: "THEOREM-A" });
  });

  it("mined cargo has no cost basis: the delivery row carries none", async () => {
    const { cm, ledger } = harness([contract({ id: "c1", accepted: true })]);
    await cm.deliverVia(shipAt(DEST));
    assert.equal(ledger[0]!.pricePerUnit, undefined);
  });

  it("the payout row is marked PAYOUT and tied to the contract", async () => {
    const c = contract({ id: "c1", accepted: true });
    c.terms.deliver![0]!.unitsFulfilled = 22;
    const { cm, ledger } = harness([c]);
    await cm.fulfillCompleted();
    assert.deepEqual({ type: ledger[0]!.type, tradeSymbol: ledger[0]!.tradeSymbol, total: ledger[0]!.total, contractId: ledger[0]!.contractId }, { type: "CONTRACT", tradeSymbol: "PAYOUT", total: 7607, contractId: "c1" });
  });
});
