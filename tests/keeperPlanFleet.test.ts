import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/** The seam where the fleet uses keeperPlan.ts: top-up candidates, the plan pass, and the saved route tracking (issue #63). */
const goodsRow = (wp: string, n: number) => ({ waypointSymbol: wp, systemSymbol: "X1-AA", imports: Array.from({ length: n }, (_, i) => `G${i}`), exports: [], exchange: [], updatedAt: new Date().toISOString() });

function fake(opts: { planOn: boolean; mode?: number; flag?: string; keepers?: [string, string][]; listed?: string[] }) {
  const flags = new Map<string, string>();
  if (opts.flag) flags.set("keeperRouteSeen", opts.flag);
  const added: string[][] = [];
  const fleetState: string[] = [];
  const listed: string[] = [...(opts.listed ?? [])];
  const self: any = {
    tenantId: "t",
    store: {
      marketDirectory: async () => [goodsRow("X1-AA-NINE", 9), goodsRow("X1-AA-SEVEN", 7), goodsRow("X1-AA-BIG", 14), goodsRow("X1-AA-YARD", 2), goodsRow("X1-AA-ROUTE", 5)],
      shipyardDirectory: async () => [{ waypointSymbol: "X1-AA-YARD" }],
      latestMarketSnapshots: async () => [],
      getFleetFlag: async (_t: string, k: string) => flags.get(k),
      setFleetFlag: async (_t: string, k: string, v: string) => { flags.set(k, v); },
      setFleetState: async (_t: string, ship: string, _role: string, m: string) => { fleetState.push(`${ship}=${m}`); },
    },
    doctrine: {
      isEnabledOr: (k: string, d: boolean) => (k === "keeperTourPlan" ? opts.planOn : k === "keeperMinGoods" ? true : d),
      value: (k: string, d?: number) => (k === "keeperTourPlan" ? opts.mode ?? 1 : k === "keeperMinGoods" ? 1 : d ?? 0),
    },
    systemQueue: { list: () => [{ system: "X1-AA", state: "live", held: false }] },
    keeperMarkets: new Map(opts.keepers ?? []),
    parkedKeeperMarkets: new Map(),
    idleParked: new Map(),
    keeperPollMs: () => 300_000,
    keeperPriorityMarkets: async () => [...listed],
    setKeeperPriorityMarkets: async (m: string[]) => { listed.splice(0, listed.length, ...m); return m; },
    addKeeperPriorityMarkets: async (m: string[]) => { added.push(m); return m; },
    intents: { propose: () => {} },
    recordAction: () => {},
    log: () => {},
  };
  for (const k of ["keeperPlanPolicy", "keeperRouteSeen", "saveKeeperRouteSeen", "noteKeeperPlanRoutes", "keeperPlanInput", "maybeKeeperPlan", "repinKeeper", "coveredKeeperMarkets", "topUpFacts", "keeperPlanData"]) {
    self[k] = (FleetManager.prototype as any)[k].bind(self);
  }
  self.lastKeeperPlanAt = 0;
  return { self, flags, added, fleetState, listed };
}

describe("tour plan at the fleet seam", () => {
  it("with the clause off, top-up candidates are exactly as before", async () => {
    const { self } = fake({ planOn: false });
    const f = await self.topUpFacts(Date.now());
    assert.deepEqual([...f.systems[0].candidates].sort(), ["X1-AA-BIG", "X1-AA-NINE", "X1-AA-ROUTE", "X1-AA-SEVEN", "X1-AA-YARD"]);
  });

  it("with the clause on, top-up only offers yards, 13+ goods, 7 goods and good-route ends", async () => {
    const { self } = fake({ planOn: true });
    await self.noteKeeperPlanRoutes([{ good: "X", buyAt: "X1-AA-ROUTE", sellAt: "X1-ZZ-S", profitPerTrip: 90_000 }]);
    const f = await self.topUpFacts(Date.now());
    assert.deepEqual([...f.systems[0].candidates].sort(), ["X1-AA-BIG", "X1-AA-ROUTE", "X1-AA-SEVEN", "X1-AA-YARD"], "the 9-goods market is left to touring");
  });

  it("saves route tracking as it changes, and a fresh instance restores it", async () => {
    const a = fake({ planOn: true });
    await a.self.noteKeeperPlanRoutes([{ good: "X", buyAt: "X1-AA-ROUTE", sellAt: "X1-ZZ-S", profitPerTrip: 90_000 }]);
    const saved = a.flags.get("keeperRouteSeen");
    assert.ok(saved && saved.includes("X1-AA-ROUTE"));
    const b = fake({ planOn: true, flag: saved });
    const state = await b.self.keeperRouteSeen(Date.now());
    assert.ok(state.seen.has("X1-AA-ROUTE"), "restored after a restart");
  });

  it("mode 1 lists an uncovered good-route end; mode 2 moves an idle keeper there instead", async () => {
    const old = JSON.stringify({ trackedSince: Date.now() - 10 * 3_600_000, lastNoted: Date.now() - 60_000, seen: { "X1-AA-ROUTE": Date.now() } });
    const one = fake({ planOn: true, mode: 1, flag: old, keepers: [["S-1", "X1-AA-NINE"]] });
    await one.self.maybeKeeperPlan();
    assert.deepEqual(one.added, [["X1-AA-ROUTE"]]);
    assert.equal(one.self.keeperMarkets.get("S-1"), "X1-AA-NINE", "mode 1 moves no hull");

    const two = fake({ planOn: true, mode: 2, flag: old, keepers: [["S-1", "X1-AA-NINE"]], listed: ["X1-AA-NINE", "X1-AA-BIG"] });
    await two.self.maybeKeeperPlan();
    assert.deepEqual(two.listed, ["X1-AA-BIG", "X1-AA-ROUTE"], "the market left behind is off the keeper list, so no new keeper is bought for it");
    assert.equal(two.self.keeperMarkets.get("S-1"), "X1-AA-ROUTE");
    assert.deepEqual(two.fleetState, ["S-1=X1-AA-ROUTE"], "the new pin is saved");
    assert.deepEqual(two.added, [], "nothing bought for the market the hull moved to");
  });

  it("switching the plan on after it was off restarts judging, so no keeper is demoted for the unwatched hours", async () => {
    const stale = JSON.stringify({ trackedSince: Date.now() - 10 * 3_600_000, lastNoted: Date.now() - 9 * 3_600_000, seen: {} });
    const { self } = fake({ planOn: true, mode: 2, flag: stale, keepers: [["S-1", "X1-AA-NINE"]] });
    await self.noteKeeperPlanRoutes([]);
    const data = await self.keeperPlanData();
    assert.equal(data.demote.length, 0, "the 9 unrecorded hours do not count against S-1");
  });

  it("does nothing while the clause is off", async () => {
    const { self, added, flags } = fake({ planOn: false });
    await self.maybeKeeperPlan();
    await self.noteKeeperPlanRoutes([{ good: "X", buyAt: "X1-AA-ROUTE", sellAt: "X1-ZZ-S", profitPerTrip: 90_000 }]);
    assert.deepEqual(added, []);
    assert.equal(flags.size, 0);
  });
});
