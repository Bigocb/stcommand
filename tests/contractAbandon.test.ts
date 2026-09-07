import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ContractManager } from "../src/engine/contract.js";

/**
 * "Stop working this contract."
 *
 * The API has accept, deliver, fulfil and negotiate — and no cancel — so the
 * only honest meaning of abandoning is that the fleet stops sourcing for it.
 * These tests pin that meaning: the contract stays accepted and listed, its
 * deliveries stop being outstanding, and the decision survives the process.
 */

const CONTRACT = {
  id: "cmtq3cdo1234",
  factionSymbol: "COSMIC",
  type: "PROCUREMENT",
  accepted: true,
  fulfilled: false,
  expiration: "2999-01-01T00:00:00Z",
  deadlineToAccept: "2999-01-01T00:00:00Z",
  terms: {
    deadline: "2999-01-01T00:00:00Z",
    payment: { onAccepted: 1000, onFulfilled: 181474 },
    deliver: [
      { tradeSymbol: "DRUGS", destinationSymbol: "X1-S84-H57", unitsRequired: 22, unitsFulfilled: 4 },
    ],
  },
};

function makeApi() {
  return { getContracts: async () => [structuredClone(CONTRACT)] } as never;
}

/** A store standing in for fleet_flags, so persistence can be observed. */
function makeStore() {
  const flags = new Map<string, string>();
  return {
    flags,
    getFleetFlag: async (_t: string, k: string) => flags.get(k),
    setFleetFlag: async (_t: string, k: string, v: string) => { flags.set(k, v); },
  };
}

describe("abandoning a contract stops the fleet sourcing for it", () => {
  test("an accepted contract's deliveries are outstanding until it is abandoned", async () => {
    const cm = new ContractManager(makeApi());
    assert.equal((await cm.outstandingDeliveries()).length, 1, "precondition: the work exists");

    await cm.abandon(CONTRACT.id);

    assert.deepEqual(await cm.outstandingDeliveries(), [], "no deliveries outstanding once stood down");
    assert.equal(cm.isAbandoned(CONTRACT.id), true);
  });

  test("the contract stays accepted and listed — this is not a cancel", async () => {
    const cm = new ContractManager(makeApi());
    await cm.abandon(CONTRACT.id);

    const active = await cm.listActive();
    assert.equal(active.length, 1, "still listed, so the operator can see it lapse");
    assert.equal(active[0]?.accepted, true, "still accepted — the API has no cancel");
  });

  test("resuming puts the work back", async () => {
    const cm = new ContractManager(makeApi());
    await cm.abandon(CONTRACT.id);
    await cm.resume(CONTRACT.id);

    assert.equal((await cm.outstandingDeliveries()).length, 1);
    assert.equal(cm.isAbandoned(CONTRACT.id), false);
  });

  test("deliverablesFor names the goods even once abandoned, so carriers can be released", async () => {
    const cm = new ContractManager(makeApi());
    await cm.abandon(CONTRACT.id);
    // Reads the contract directly: outstandingDeliveries() deliberately no
    // longer lists it, so a caller that went through there would release
    // nothing and the trader would keep buying.
    assert.deepEqual(await cm.deliverablesFor(CONTRACT.id), ["DRUGS"]);
  });
});

describe("operator decisions survive a redeploy", () => {
  test("abandon is persisted and replayed", async () => {
    const store = makeStore();
    const cm = new ContractManager(makeApi(), store as never, "tenant-1");
    await cm.abandon(CONTRACT.id);

    // A new process, same tenant — this service redeploys on every push.
    const after = new ContractManager(makeApi(), store as never, "tenant-1");
    assert.equal(after.isAbandoned(CONTRACT.id), false, "nothing replayed before load");
    await after.loadOperatorState();

    assert.equal(after.isAbandoned(CONTRACT.id), true, "the decision outlived the process");
    assert.deepEqual(await after.outstandingDeliveries(), []);
  });

  test("decline is persisted too — it used to be lost on every deploy", async () => {
    const store = makeStore();
    const cm = new ContractManager(makeApi(), store as never, "tenant-1");
    await cm.decline(CONTRACT.id);

    const after = new ContractManager(makeApi(), store as never, "tenant-1");
    await after.loadOperatorState();
    assert.equal(after.isDeclined(CONTRACT.id), true);
  });

  test("a corrupt blob does not stop the fleet booting", async () => {
    const store = makeStore();
    store.flags.set("contractOperatorState", "{not json");
    const logs: string[] = [];
    const cm = new ContractManager(makeApi(), store as never, "tenant-1", { log: (m) => logs.push(m) });

    await cm.loadOperatorState();

    assert.equal(cm.isAbandoned(CONTRACT.id), false);
    assert.ok(logs.some((l) => l.includes("could not be read")), "and it says so rather than passing silently");
  });
});
