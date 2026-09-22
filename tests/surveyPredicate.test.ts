import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";

// 2026-09-22, operator request: "is there a mechanic to define what we want
// a miner to mine?" SpaceTraders never lets an extraction call name its own
// result, but a survey biases the odds toward its listed deposits — this is
// ShipAgent.surveyPredicate(), the one place every survey pick in the file
// (mineAndRefine/extractUntilFull, both their initial pick and their
// re-pick after a survey expires) now goes through, so a preference set
// here reaches every one of those call sites for free. See its own comment
// for what a preference does and doesn't guarantee.

function bareMiner(opts: Record<string, unknown> = {}) {
  const ship = {
    symbol: "MINER-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-EC5D", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 80, capacity: 80 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  return new ShipAgent(ship, { api: { getCallCount: () => 0 }, ...opts } as never);
}

describe("ShipAgent.surveyPredicate(): what a miner's surveys are picked to favor", () => {
  it("with no preference set, falls back to the existing refinable-deposit check", () => {
    const agent = bareMiner();
    const predicate = (agent as any).surveyPredicate();

    assert.equal(predicate("IRON_ORE"), true, "IRON_ORE refines to a metal — the unchanged default behavior");
    assert.equal(predicate("QUARTZ_SAND"), false, "QUARTZ_SAND has no refine recipe at all");
  });

  it("with a preference set, matches only that good — even one that also happens to be refinable", () => {
    const agent = bareMiner({ preferredMiningGood: () => "IRON_ORE" });
    const predicate = (agent as any).surveyPredicate();

    assert.equal(predicate("IRON_ORE"), true);
    assert.equal(predicate("COPPER_ORE"), false, "also refinable, but not the preferred good — must not match");
  });

  it("with a preference set to a good with no refine recipe at all, still matches only that good", () => {
    const agent = bareMiner({ preferredMiningGood: () => "QUARTZ_SAND" });
    const predicate = (agent as any).surveyPredicate();

    assert.equal(predicate("QUARTZ_SAND"), true, "the whole point — a good REFINE_RECIPES would never select on its own");
    assert.equal(predicate("IRON_ORE"), false, "refinable, but the operator asked for something else specifically");
  });

  it("re-reads the preference live rather than caching it at construction", () => {
    let preferred: string | undefined = "IRON_ORE";
    const agent = bareMiner({ preferredMiningGood: () => preferred });

    assert.equal((agent as any).surveyPredicate()("IRON_ORE"), true);
    preferred = undefined;
    assert.equal((agent as any).surveyPredicate()("IRON_ORE"), true, "still true via the refinable fallback once cleared");
    assert.equal((agent as any).surveyPredicate()("QUARTZ_SAND"), false, "confirms the fallback, not a stale preferred-good match");
  });
});
