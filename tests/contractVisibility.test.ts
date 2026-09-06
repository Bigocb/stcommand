import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractManager, type Contract } from "../src/engine/contract.js";

/**
 * Contract deliveries and payouts used to happen in complete silence.
 *
 * DRAGOM-1 bought 3u DRUGS for 33,492c — a third of the fleet's capital —
 * and delivered them against a contract 47 seconds later. `deliverVia()`
 * called `api.deliverContract()` and logged nothing, recorded no activity
 * and wrote no ledger row, so from outside the fleet "delivered against the
 * contract" and "destroyed by a bug" were indistinguishable. Establishing
 * which had happened took a source read and a timestamp cross-reference
 * against a deploy history.
 *
 * `fulfillCompleted()` was worse: the payout is real money, and with no
 * ledger row it never reached ledgerSummary(). Buying contract goods was
 * booked as cost while the revenue that justified it was booked nowhere, so
 * a fleet working a profitable contract read as one bleeding money — and
 * every earnings figure quoted off that readout inherited the error.
 */

const DEST = "X1-A-DEST";

function contract(over: Partial<Contract> & { id: string }): Contract {
  return {
    factionSymbol: "COSMIC",
    type: "PROCUREMENT",
    accepted: true,
    fulfilled: false,
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    terms: {
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      payment: { onAccepted: 1000, onFulfilled: 181_474 },
      deliver: [{ tradeSymbol: "DRUGS", destinationSymbol: DEST, unitsRequired: 10, unitsFulfilled: 2 }],
    },
    ...over,
  } as Contract;
}

function harness(contracts: Contract[]) {
  const logs: string[] = [];
  const activity: { kind: string; detail: string; credits?: number; shipSymbol?: string }[] = [];
  const ledger: { type: string; total: number }[] = [];
  const delivered: { good: string; units: number }[] = [];
  const api = {
    getContracts: async () => contracts,
    dockShip: async () => {},
    fulfillContract: async () => {},
    getShipCargo: async () => ({ capacity: 40, units: 3, inventory: [{ symbol: "DRUGS", units: 3 }] }),
    deliverContract: async (_id: string, _ship: string, good: string, units: number) => {
      delivered.push({ good, units });
    },
  } as never;
  const cm = new ContractManager(api, undefined, {
    log: (m) => logs.push(m),
    onActivity: (kind, detail, credits, shipSymbol) => activity.push({ kind, detail, credits, shipSymbol }),
    recordLedger: (e) => ledger.push({ type: e.type, total: e.total }),
  });
  return { cm, logs, activity, ledger, delivered };
}

const shipAt = (waypoint: string) => ({
  symbol: "DRAGOM-1",
  nav: { waypointSymbol: waypoint, status: "DOCKED", systemSymbol: "X1-A" },
  cargo: { capacity: 40, units: 3, inventory: [{ symbol: "DRUGS", units: 3 }] },
}) as never;

describe("a contract delivery announces itself", () => {
  it("names the units, the good and how far along the contract now is", async () => {
    const { cm, logs, delivered } = harness([contract({ id: "cmtq3cdo4emgiuo6xwzjs0u6t" })]);
    assert.equal(await cm.deliverVia(shipAt(DEST)), true);
    assert.deepEqual(delivered, [{ good: "DRUGS", units: 3 }], "the delivery itself must still happen");
    const line = logs.join("\n");
    assert.match(line, /delivered 3u DRUGS/);
    assert.match(line, /\(5\/10\)/, "progress is the part that says nearly-done from barely-started");
    assert.match(line, /cmtq3cdo/, "which contract, so two open contracts are never confused");
  });

  it("reaches the activity feed, not just the log", async () => {
    const { cm, activity } = harness([contract({ id: "c1" })]);
    await cm.deliverVia(shipAt(DEST));
    const entry = activity.find((a) => a.kind === "contract-deliver");
    assert.ok(entry, "a delivery the dashboard cannot see is still invisible to an operator");
    assert.equal(entry.shipSymbol, "DRAGOM-1");
    assert.match(entry.detail, /3u DRUGS/);
  });

  it("says nothing when the ship is somewhere else, because nothing happened", async () => {
    const { cm, logs, activity, delivered } = harness([contract({ id: "c1" })]);
    const res = await cm.deliverVia(shipAt("X1-A-ELSEWHERE"));
    assert.equal(res, DEST, "it should report where to go instead");
    assert.deepEqual(delivered, []);
    assert.deepEqual(logs, [], "a log line for a delivery that did not occur is the same disease");
    assert.deepEqual(activity, []);
  });
});

describe("a contract payout enters the books", () => {
  const done = () => contract({
    id: "c1",
    terms: {
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      payment: { onAccepted: 1000, onFulfilled: 181_474 },
      deliver: [{ tradeSymbol: "DRUGS", destinationSymbol: DEST, unitsRequired: 10, unitsFulfilled: 10 }],
    },
  } as never);

  it("writes a ledger row for the payout", async () => {
    const { cm, ledger } = harness([done()]);
    await cm.fulfillCompleted();
    assert.deepEqual(ledger, [{ type: "CONTRACT", total: 181_474 }],
      "without this the cost of contract goods is booked and the revenue is not");
  });

  it("logs the payout and reports it as activity", async () => {
    const { cm, logs, activity } = harness([done()]);
    await cm.fulfillCompleted();
    assert.match(logs.join("\n"), /fulfilled — 181474c paid/);
    const entry = activity.find((a) => a.kind === "contract-fulfilled");
    assert.ok(entry);
    assert.equal(entry.credits, 181_474);
  });

  it("stays silent for a contract that is not finished", async () => {
    const { cm, logs, ledger } = harness([contract({ id: "c1" })]);
    await cm.fulfillCompleted();
    assert.deepEqual(ledger, []);
    assert.deepEqual(logs, []);
  });
});
