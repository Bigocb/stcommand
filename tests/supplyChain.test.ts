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
  // As the live /market/supply-chain returns it (checked 2026-10-05): KEY = exported good, values = what it imports to make it.
  const map = {
    FAB_MATS: ["IRON", "QUARTZ_SAND"],
    IRON: ["IRON_ORE"],
    MACHINERY: ["IRON"],
    QUARTZ_SAND: ["EXPLOSIVES"],
    IRON_ORE: ["EXPLOSIVES"],
    EXPLOSIVES: ["LIQUID_HYDROGEN", "LIQUID_NITROGEN"],
    COPPER: ["COPPER_ORE"],
    ELECTRONICS: ["SILICON_CRYSTALS", "COPPER"],
    MICROPROCESSORS: ["SILICON_CRYSTALS", "COPPER"],
    ADVANCED_CIRCUITRY: ["ELECTRONICS", "MICROPROCESSORS"],
    QUANTUM_STABILIZERS: ["PLATINUM", "ADVANCED_CIRCUITRY"],
  };

  it("walks back from a material to every input down to the raw ore, without sideways or downstream goods", () => {
    assert.deepEqual([...transitiveInputs(["FAB_MATS"], map)].sort(), ["IRON", "IRON_ORE", "QUARTZ_SAND"]);
    assert.deepEqual(
      [...transitiveInputs(["ADVANCED_CIRCUITRY"], map)].sort(),
      ["COPPER", "COPPER_ORE", "ELECTRONICS", "MICROPROCESSORS", "SILICON_CRYSTALS"],
    );
    assert.ok(!transitiveInputs(["FAB_MATS"], map).has("MACHINERY"), "something made FROM iron is not an input");
  });

  it("never pulls in explosives (every raw-ore market 'imports' it)", () => {
    const got = transitiveInputs(["FAB_MATS", "ADVANCED_CIRCUITRY"], map);
    assert.ok(!got.has("EXPLOSIVES") && !got.has("LIQUID_HYDROGEN"));
  });

  it("unions several roots and is empty for an unknown or raw-only good", () => {
    assert.ok(transitiveInputs(["FAB_MATS", "ADVANCED_CIRCUITRY"], map).has("QUARTZ_SAND"));
    assert.equal(transitiveInputs(["NOT_A_GOOD"], map).size, 0);
    assert.equal(transitiveInputs(["IRON_ORE"], map).size, 0);
  });
});
