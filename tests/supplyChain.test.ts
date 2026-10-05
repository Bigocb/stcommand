import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSupplyChain, resetSupplyChainCacheForTests, transitiveInputs } from "../src/engine/supplyChain.js";

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

describe("transitiveInputs", () => {
  // The live API keys by INPUT: IRON_ORE -> goods it is used to make.
  const map = {
    IRON_ORE: ["IRON", "EXPLOSIVES"],
    IRON: ["FAB_MATS", "MACHINERY"],
    QUARTZ_SAND: ["FAB_MATS", "EXPLOSIVES"],
    COPPER_ORE: ["COPPER"],
    COPPER: ["ELECTRONICS", "MICROPROCESSORS"],
    SILICON_CRYSTALS: ["ELECTRONICS", "MICROPROCESSORS"],
    ELECTRONICS: ["ADVANCED_CIRCUITRY"],
    MICROPROCESSORS: ["ADVANCED_CIRCUITRY"],
  };

  it("walks back from a material to every input and raw ore, without sideways goods", () => {
    assert.deepEqual([...transitiveInputs(["FAB_MATS"], map)].sort(), ["IRON", "IRON_ORE", "QUARTZ_SAND"]);
    assert.deepEqual(
      [...transitiveInputs(["ADVANCED_CIRCUITRY"], map)].sort(),
      ["COPPER", "COPPER_ORE", "ELECTRONICS", "MICROPROCESSORS", "SILICON_CRYSTALS"],
    );
  });

  it("unions several roots and is empty for an unknown or raw good", () => {
    assert.ok(transitiveInputs(["FAB_MATS", "ADVANCED_CIRCUITRY"], map).has("QUARTZ_SAND"));
    assert.equal(transitiveInputs(["NOT_A_GOOD"], map).size, 0);
    assert.equal(transitiveInputs(["IRON_ORE"], map).size, 0);
  });
});
