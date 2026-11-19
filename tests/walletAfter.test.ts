import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpaceTradersAPI } from "../src/core/client.js";

// A trade response carries the wallet; the API object keeps the latest so the ledger can stamp it on each row.
describe("SpaceTradersAPI.lastKnownCredits", () => {
  const fake = (credits: number) => ({ post: async () => ({ agent: { credits }, cargo: {}, transaction: {} }) }) as never;

  it("starts unknown and follows each sell and purchase response", async () => {
    const api = new SpaceTradersAPI(fake(1_000) , "t");
    assert.equal(api.lastKnownCredits, undefined);
    await api.sellCargo("S-1", "IRON", 5);
    assert.equal(api.lastKnownCredits, 1_000);
    (api as any).client = fake(640);
    await api.purchaseCargo("S-1", "IRON", 5);
    assert.equal(api.lastKnownCredits, 640);
  });

  it("keeps the previous balance when a response carries no agent", async () => {
    const api = new SpaceTradersAPI(fake(500), "t");
    await api.sellCargo("S-1", "IRON", 1);
    (api as any).client = { post: async () => ({ cargo: {} }) };
    await api.purchaseCargo("S-1", "IRON", 1);
    assert.equal(api.lastKnownCredits, 500);
  });

  it("follows jump, refuel and contract responses too (2026-11-19: JUMP/REFUEL rows carried the previous trade's balance)", async () => {
    const api = new SpaceTradersAPI(fake(900), "t");
    await api.jumpShip("S-1", "X1-B-I1");
    assert.equal(api.lastKnownCredits, 900);
    (api as any).client = fake(880);
    await api.refuelShip("S-1");
    assert.equal(api.lastKnownCredits, 880);
    (api as any).client = fake(50_880);
    await api.fulfillContract("C-1");
    assert.equal(api.lastKnownCredits, 50_880);
    (api as any).client = fake(60_000);
    await api.acceptContract("C-2");
    assert.equal(api.lastKnownCredits, 60_000);
  });
});
