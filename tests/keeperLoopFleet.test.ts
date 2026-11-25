import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/** The seam where the fleet uses keeperLoop.ts: making loop keepers (mode 3), stepping them on each read, and the saved flag. */
const row = (wp: string, n: number) => ({ waypointSymbol: wp, systemSymbol: "X1-AA", imports: Array.from({ length: n }, (_, i) => `G${i}`), exports: [], exchange: [], updatedAt: new Date().toISOString() });

function fake(opts: { mode: number; flags?: Record<string, string>; keepers?: [string, string][]; loopBuy?: boolean; queue?: { system: string; state: string; held: boolean }[] }) {
  const flags = new Map<string, string>(Object.entries(opts.flags ?? {}));
  const fleetState: string[] = [];
  const listed: string[] = ["X1-AA-K1"];
  const self: any = {
    tenantId: "t",
    store: {
      marketDirectory: async () => [row("X1-AA-K1", 9), row("X1-AA-T2", 8), row("X1-AA-T3", 5), row("X1-AA-T4", 4), row("X1-AA-BIG", 14)],
      shipyardDirectory: async () => [],
      getFleetFlag: async (_t: string, k: string) => flags.get(k),
      setFleetFlag: async (_t: string, k: string, v: string) => { flags.set(k, v); },
      setFleetState: async (_t: string, ship: string, _r: string, m: string) => { fleetState.push(`${ship}=${m}`); },
    },
    doctrine: {
      isEnabledOr: (k: string, d: boolean) => (k === "keeperTourPlan" ? true : k === "keeperPlanLoopBuy" ? !!opts.loopBuy : d),
      value: (k: string, d?: number) => (k === "keeperTourPlan" ? opts.mode : k === "keeperPlanLoopBuy" ? 2 : d ?? 0),
    },
    systemQueue: { list: () => opts.queue ?? [{ system: "X1-AA", state: "live", held: false }] },
    keeperMarkets: new Map(opts.keepers ?? [["S-1", "X1-AA-K1"]]),
    parkedKeeperMarkets: new Map(), idleParked: new Map(),
    keeperPollMs: () => 300_000,
    keeperPriorityMarkets: async () => [...listed],
    setKeeperPriorityMarkets: async (m: string[]) => { listed.splice(0, listed.length, ...m); return m; },
    addKeeperPriorityMarkets: async (m: string[]) => { listed.push(...m); return m; },
    intents: { propose: () => {} }, recordAction: () => {}, log: () => {},
    keeperReads: { note: () => {} },
    loopKeeperShips: new Map(), loopKeepersLoaded: false, lastKeeperPlanAt: 0, loopSeeds: new Map(),
  };
  for (const k of ["keeperPlanPolicy", "keeperRouteSeen", "saveKeeperRouteSeen", "keeperPlanInput", "maybeKeeperPlan", "repinKeeper", "coveredKeeperMarkets", "keeperPlanData",
    "loadLoopKeepers", "saveLoopKeepers", "planLoopKeepers", "onKeeperRead", "isLoopKeeper", "keeperCoverSystems", "planLoopSeedsPass", "saveLoopSeeds"]) self[k] = (FleetManager.prototype as any)[k].bind(self);
  return { self, flags, fleetState, listed };
}
const old = JSON.stringify({ trackedSince: Date.now() - 10 * 3_600_000, lastNoted: Date.now() - 60_000, seen: {} });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("loop keepers at the fleet seam", () => {
  it("mode 3 turns an idle keeper into a loop keeper and takes its old market off the keeper list", async () => {
    const { self, flags, listed } = fake({ mode: 3, flags: { keeperRouteSeen: old } });
    await self.maybeKeeperPlan();
    assert.ok(self.isLoopKeeper("S-1"));
    assert.deepEqual(self.loopKeeperShips.get("S-1").markets, ["X1-AA-K1", "X1-AA-T2", "X1-AA-T3", "X1-AA-T4"]);
    assert.ok(flags.get("keeperLoops")?.includes("S-1"), "saved at once");
    assert.deepEqual(listed, [], "no new keeper is bought for the market it left");
  });

  it("each read steps the pin to the next market and saves it; a fresh instance restores the loop", async () => {
    const a = fake({ mode: 3, flags: { keeperRouteSeen: old } });
    await a.self.maybeKeeperPlan();
    a.self.onKeeperRead("S-1", "X1-AA-K1");
    await tick();
    assert.equal(a.self.keeperMarkets.get("S-1"), "X1-AA-T2");
    assert.deepEqual(a.fleetState.slice(-1), ["S-1=X1-AA-T2"]);
    const b = fake({ mode: 3, flags: { keeperRouteSeen: old, keeperLoops: a.flags.get("keeperLoops")! }, keepers: [["S-1", "X1-AA-T2"]] });
    await b.self.maybeKeeperPlan();
    assert.equal(b.self.loopKeeperShips.get("S-1").idx, 1, "restored where it was");
    b.self.onKeeperRead("S-1", "X1-AA-T2");
    assert.equal(b.self.keeperMarkets.get("S-1"), "X1-AA-T3");
  });

  it("below mode 3 a saved loop keeper is an ordinary keeper: no stepping, no fast polls", async () => {
    const loops = JSON.stringify([{ ship: "S-1", system: "X1-AA", markets: ["X1-AA-K1", "X1-AA-T2", "X1-AA-T3"], idx: 0, lapStartMs: 0 }]);
    const { self } = fake({ mode: 2, flags: { keeperRouteSeen: old, keeperLoops: loops } });
    await self.maybeKeeperPlan();
    assert.equal(self.isLoopKeeper("S-1"), false);
    self.onKeeperRead("S-1", "X1-AA-K1");
    assert.equal(self.keeperMarkets.get("S-1"), "X1-AA-K1");
  });
});

describe("loop seeds at the fleet seam (operator 2026-11-25)", () => {
  // X1-AA's only keeper sits on the 14-goods market (fixed by the goods rule), so no idle keeper exists to make a loop from.
  const fresh = JSON.stringify({ trackedSince: Date.now() - 10 * 3_600_000, lastNoted: Date.now() - 60_000, seen: {} });

  it("clause on: a system with no idle keeper gets a tour-only market listed as a seed, saved at once", async () => {
    const { self, flags, listed } = fake({ mode: 3, loopBuy: true, flags: { keeperRouteSeen: fresh }, keepers: [["S-9", "X1-AA-BIG"]] });
    await self.maybeKeeperPlan();
    assert.equal(self.loopKeeperShips.size, 0);
    assert.ok(listed.includes("X1-AA-T2"), `seed listed (K1 was already listed): ${listed}`);
    assert.ok(flags.get("keeperLoopSeeds")?.includes("X1-AA-T2"));
  });

  it("clause off: nothing is listed (today's behaviour)", async () => {
    const { self, listed } = fake({ mode: 3, flags: { keeperRouteSeen: fresh }, keepers: [["S-9", "X1-AA-BIG"]] });
    await self.maybeKeeperPlan();
    assert.deepEqual(listed, ["X1-AA-K1"], "only the starting list");
    assert.equal(self.loopSeeds.size, 0);
  });

  it("the keeper bought for a seed becomes the loop keeper after a restart, and the seed is dropped", async () => {
    const seeds = JSON.stringify({ "X1-AA-K1": { system: "X1-AA", at: Date.now() - 60_000 } });
    const { self, flags } = fake({ mode: 3, loopBuy: true, flags: { keeperRouteSeen: fresh, keeperLoopSeeds: seeds }, keepers: [["S-9", "X1-AA-BIG"], ["P-1", "X1-AA-K1"]] });
    await self.maybeKeeperPlan();
    assert.ok(self.isLoopKeeper("P-1"), "seed keeper is the loop");
    assert.equal(self.loopSeeds.size, 0);
    assert.equal(flags.get("keeperLoopSeeds"), "{}");
  });

  it("a system we keep markets in that is not in the fresh queue (the home system) is covered", () => {
    const { self } = fake({ mode: 3, queue: [{ system: "X1-ZZ", state: "live", held: false }, { system: "X1-QQ", state: "staged", held: false }], keepers: [["S-1", "X1-AA-K1"], ["S-2", "X1-QQ-1"]] });
    assert.deepEqual(self.keeperCoverSystems(), ["X1-AA", "X1-ZZ"]);
  });
});
