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
});
