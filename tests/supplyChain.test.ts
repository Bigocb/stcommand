import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSupplyChain, resetSupplyChainCacheForTests } from "../src/engine/supplyChain.js";

describe("getSupplyChain", () => {
  beforeEach(() => resetSupplyChainCacheForTests());

  it("derives knownGoods from both the export keys and every good they feed into", async () => {
    const api = {
      getSupplyChain: async () => ({
        exportToImportMap: {
          IRON_ORE: ["IRON"],
          IRON: ["SHIP_PLATING", "SHIP_PARTS"],
        },
      }),
    } as any;

    const chain = await getSupplyChain(api);

    assert.ok(chain.knownGoods.has("IRON_ORE"), "a raw export itself must be known");
    assert.ok(chain.knownGoods.has("IRON"), "a good that's both an import and its own further export must be known");
    assert.ok(chain.knownGoods.has("SHIP_PLATING"), "a good that only ever appears as an import must still be known");
    assert.ok(!chain.knownGoods.has("SOMETHING_NOT_IN_THE_GRAPH"));
  });

  it("only fetches once per process lifetime (within the TTL), not once per call", async () => {
    let calls = 0;
    const api = { getSupplyChain: async () => { calls += 1; return { exportToImportMap: { A: ["B"] } }; } } as any;

    await getSupplyChain(api);
    await getSupplyChain(api);
    await getSupplyChain(api);

    assert.equal(calls, 1, "a cached, effectively-static response must not be re-fetched on every call");
  });
});
