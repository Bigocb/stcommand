import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * 2026-10-25: THEOREM-B5 was refused a jump to X1-DF92 (its gate is unbuilt), the refusal went to the explore task's catch, and the
 * ship sat in orbit at X1-ZR49 for 20 minutes with nothing in its log. The skip was recorded, so the next attempt would have
 * chosen another system; the gap was that nothing tried again in the same call. An explorer now moves on to the next target at once.
 */

function setup(blocked: string[], neighbours = ["X1-DF", "X1-OK", "X1-OK2"]) {
  const logs: string[] = [];
  const jumped: string[] = [];
  const fleet = new FleetManager({
    api: {
      onMarket: () => {},
      getShip: async () => ({
        symbol: "S-1",
        nav: { systemSymbol: "X1-A", status: "IN_ORBIT", waypointSymbol: "X1-A-GATE" },
        cargo: { units: 0, capacity: 40, inventory: [] },
        fuel: { capacity: 100, current: 100 },
        registration: { role: "EXPLORER" },
      }),
      getConstruction: async (system: string) => ({
        isComplete: !blocked.includes(system),
        materials: [{ tradeSymbol: "FAB_MATS", fulfilled: 0, required: 1600 }],
      }),
    } as any,
  });
  (fleet as any).log = (m: string) => logs.push(m);
  (fleet as any).galaxy = {
    connectedSystems: () => neighbours,
    loadSystem: async () => {},
    gatesTo: () => ["X1-A-GATE"],
    getSystem: (s: string) => ({ symbol: s, waypoints: [{ symbol: `${s}-GATE`, type: "JUMP_GATE", chart: {} }, ...[1, 2, 3, 4, 5].map((i) => ({ symbol: `${s}-M${i}`, type: "PLANET", traits: [{ symbol: "MARKETPLACE" }, ...(i === 1 ? [{ symbol: "SHIPYARD" }] : [])] }))] }),
    refreshGateConstruction: async (system: string) => !blocked.includes(system),
    graphNeighbours: () => [],
    frontierSystems: () => [],
    listSystems: () => [],
  };
  (fleet as any).markSystemCharted = async () => {};
  (fleet as any).surveySystem = async () => {};
  (fleet as any).jumpShip = async (_s: string, gate: string) => {
    jumped.push(gate);
  };
  return { fleet, logs, jumped };
}

describe("an explorer whose first target has an unfinished gate moves on in the same call", () => {
  it("skips the blocked system, logs it, and jumps to the next one", async () => {
    const { fleet, logs, jumped } = setup(["X1-DF"]);

    const target = await (fleet as any).exploreSystem("S-1");

    assert.equal(target, "X1-OK");
    assert.equal(jumped[0], "X1-OK-GATE", "the first jump must be through the open gate");
    assert.ok(!jumped.includes("X1-DF-GATE"), "must not jump through the blocked gate");
    assert.ok(logs.some((l) => /X1-DF skipped for now/.test(l) && /choosing another target/.test(l)), `expected a skip line, got ${JSON.stringify(logs)}`);
    assert.ok((fleet as any).gateConstructionSkipUntil.get("X1-DF") > Date.now(), "the skip must still be recorded");
  });

  it("gives up after the try limit instead of looping", async () => {
    const { fleet, jumped } = setup(["X1-DF", "X1-OK", "X1-OK2"]);

    await assert.rejects(() => (fleet as any).exploreSystem("S-1"), /remote gate .* is under construction/);
    assert.deepEqual(jumped, []);
  });

  it("never swaps a target the caller asked for", async () => {
    const { fleet, jumped } = setup(["X1-DF"]);

    await assert.rejects(() => (fleet as any).exploreSystem("S-1", "X1-DF"), /under construction/);
    assert.deepEqual(jumped, []);
  });
});

describe("an explorer with nowhere to go says why", () => {
  it("logs the connected count and the systems skipped for construction, once per 30 minutes", async () => {
    const { fleet, logs } = setup([], ["X1-DF"]);
    (fleet as any).gateConstructionSkipUntil = new Map([["X1-DF", Date.now() + 60_000]]);

    await assert.rejects(() => (fleet as any).exploreSystem("S-1"));
    await assert.rejects(() => (fleet as any).exploreSystem("S-1"));

    const lines = logs.filter((l) => /explorer: no target from X1-A/.test(l));
    assert.equal(lines.length, 1, "throttled to one line");
    assert.match(lines[0]!, /1 connected, 1 skipped while their gate is built \(X1-DF\)/);
  });
});
