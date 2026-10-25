import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";

/**
 * The seam where FleetManager uses keeperBuy.ts: a market that needs a keeper, in a system whose yard has stored probe
 * stock. No database: the store, approval gate and purchase are fakes, so this runs anywhere.
 */
const YARD = "X1-T-YARD";
const MARKET = "X1-T-M1";

function makeFleet(opts: { clauseOn: boolean; cap?: number; price?: number; shipsAtYard: { symbol: string; role: string; waypoint: string; nav: string }[] }) {
  const calls = { purchase: [] as unknown[][], approval: 0, dock: 0 };
  const fleet = new FleetManager({
    api: {
      getShip: async (s: string) => ({ symbol: s, nav: { status: "IN_ORBIT", waypointSymbol: YARD, systemSymbol: "X1-T" } }),
      dockShip: async () => { calls.dock++; },
    } as any,
  }) as any;
  fleet.tenantId = "t1";
  fleet.store = {
    shipyardInventory: async () => [{ systemSymbol: "X1-T", waypointSymbol: YARD, shipType: "SHIP_PROBE", purchasePrice: opts.price ?? 28_959, timestamp: new Date().toISOString() }],
    getUnconsumedApproval: async () => undefined,
    latestMarketSnapshots: async () => [],
    getFleetFlag: async () => undefined,
    setFleetFlag: async () => {},
  };
  fleet.lastDispatchRoutes = [];
  fleet.doctrine = {
    isEnabledOr: (k: string) => (k === "autoApproveKeeperProbes" ? opts.clauseOn : k === "keeperAutoApproveMinCash" ? false : true),
    value: (k: string, def?: number) => (k === "autoApproveKeeperProbes" ? opts.cap ?? 60_000 : def ?? 5),
  };
  fleet.approvals = { request: async () => { calls.approval++; return undefined; } };
  fleet.canAfford = () => true;
  fleet.keeperPriorityMarkets = async () => [MARKET];
  fleet.keeperTargetCovered = async () => false;
  fleet.otherKeeperKindTargets = async () => false;
  fleet.fleetStatusSummary = () => opts.shipsAtYard;
  fleet.purchaseKeeperProbe = async (...args: unknown[]) => { calls.purchase.push(args); };
  return { fleet, calls };
}

const keeperAtYard = [{ symbol: "K-1", role: "keeper", waypoint: YARD, nav: "IN_ORBIT" }];

describe("market keeper request with autoApproveKeeperProbes", () => {
  it("clause on, a ship at the yard: buys through it, raises no card, and ends the pass", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, shipsAtYard: keeperAtYard });
    const r = await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(r, true);
    assert.deepEqual(calls.purchase, [[YARD, MARKET, 28_959, "SHIP_PROBE"]]);
    assert.equal(calls.approval, 0, "no approval card");
    assert.equal(calls.dock, 1, "an orbiting ship is docked before the purchase");
  });

  it("clause on, nobody at the yard: no purchase, no card, and the queue is told to move on", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, shipsAtYard: [] });
    const r = await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(r, false, "false lets advanceKeeperMarketQueue try the next market");
    assert.deepEqual(calls.purchase, []);
    assert.equal(calls.approval, 0);
  });

  it("clause off: today's behaviour, an approval card and no purchase", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: false, shipsAtYard: keeperAtYard });
    await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(calls.approval, 1);
    assert.deepEqual(calls.purchase, []);
  });

  it("clause on but the quote is over the cap: asks the operator", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, cap: 20_000, shipsAtYard: keeperAtYard });
    await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(calls.approval, 1);
    assert.deepEqual(calls.purchase, []);
  });
});

describe("addKeeperPriorityMarkets", () => {
  it("appends to the list instead of replacing it, and checks only the newly added markets", async () => {
    const { fleet } = makeFleet({ clauseOn: true, shipsAtYard: keeperAtYard });
    const written: string[][] = [];
    const checked: string[] = [];
    fleet.keeperPriorityMarkets = async () => ["X1-OLD-1", "X1-OLD-2"];
    fleet.store.setFleetFlag = async (_t: string, _k: string, v: string) => { written.push(JSON.parse(v)); };
    fleet.recordAction = () => {};
    fleet.maybeRequestKeeperProbeForMarket = async (m: string) => { checked.push(m); return false; };

    const out = await fleet.addKeeperPriorityMarkets(["X1-NEW-1", "X1-OLD-2", "X1-NEW-2"]);

    assert.deepEqual(out, ["X1-OLD-1", "X1-OLD-2", "X1-NEW-1", "X1-NEW-2"]);
    assert.deepEqual(written, [out]);
    assert.deepEqual(checked, ["X1-NEW-1", "X1-NEW-2"], "markets already on the list are not re-checked");
  });
});

describe("keeperCandidatesForSystem", () => {
  const wps = ["X1-S-A", "X1-S-B", "X1-S-C"].map((symbol) => ({ symbol, traits: [{ symbol: "MARKETPLACE" }] }));
  function setup(minGoodsOn: boolean) {
    const { fleet } = makeFleet({ clauseOn: true, shipsAtYard: [] });
    fleet.galaxy = { getSystem: () => ({ waypoints: wps }) };
    fleet.keeperPriorityMarkets = async () => ["X1-S-C"];
    fleet.markets = [
      { symbol: "X1-S-A", systemSymbol: "X1-S", imports: ["F", "G"], exports: ["H", "I"], exchange: ["J"], tradeGoods: {} },
      { symbol: "X1-S-B", systemSymbol: "X1-S", imports: ["F"], exports: [], exchange: ["J"], tradeGoods: {} },
    ];
    fleet.doctrine = {
      isEnabledOr: (k: string) => (k === "keeperMinGoods" ? minGoodsOn : true),
      value: (k: string, d?: number) => (k === "keeperMinGoods" ? 3 : d ?? 5),
    };
    return fleet;
  }
  it("lists unlisted markets that trade enough goods, and reports the thin ones", async () => {
    const r = await setup(true).keeperCandidatesForSystem("X1-S");
    assert.deepEqual(r.add, ["X1-S-A"]);
    assert.deepEqual(r.thin, [{ market: "X1-S-B", goods: 2 }]);
  });
  it("with keeperMinGoods off, every unlisted market is added", async () => {
    const r = await setup(false).keeperCandidatesForSystem("X1-S");
    assert.deepEqual(r.add, ["X1-S-A", "X1-S-B"]);
    assert.deepEqual(r.thin, []);
  });
});

describe("keeper budget (keeperMaxTotal)", () => {
  it("a full budget stops the automatic buy without raising an approval card", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, shipsAtYard: keeperAtYard });
    fleet.keepers = new Map(Array.from({ length: 5 }, (_, i) => [`K-${i}`, {}]));   // doctrine stub's keeperMaxTotal is 5
    const r = await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(r, false, "skipped, so the queue moves on");
    assert.deepEqual(calls.purchase, []);
    assert.equal(calls.approval, 0, "no card either");
  });

  it("with room left it buys as before", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: true, shipsAtYard: keeperAtYard });
    fleet.keepers = new Map([["K-0", {}]]);
    assert.equal(await fleet.maybeRequestKeeperProbeForMarket(MARKET), true);
    assert.equal(calls.purchase.length, 1);
  });

  it("the limit does not apply when auto-approve is off: the operator's card still comes", async () => {
    const { fleet, calls } = makeFleet({ clauseOn: false, shipsAtYard: keeperAtYard });
    fleet.keepers = new Map(Array.from({ length: 9 }, (_, i) => [`K-${i}`, {}]));
    await fleet.maybeRequestKeeperProbeForMarket(MARKET);
    assert.equal(calls.approval, 1);
  });
});

describe("keeper scoring in the fleet", () => {
  const snap = (symbol: string, exportsList: string[]) => ({ symbol, systemSymbol: "X1-S", imports: [], exports: exportsList, exchange: [], tradeGoods: {} });
  function scoringFleet() {
    const { fleet } = makeFleet({ clauseOn: true, shipsAtYard: [] });
    const flags = new Map<string, string>();
    fleet.store.latestMarketSnapshots = async () => [
      { waypointSymbol: "X1-Z-A", goodSymbol: "RICH", type: "EXPORT", sellPrice: 5000, systemSymbol: "X1-Z" },
      { waypointSymbol: "X1-Z-A", goodSymbol: "CHEAP", type: "EXPORT", sellPrice: 50, systemSymbol: "X1-Z" },
    ];
    fleet.store.getFleetFlag = async (_t: string, k: string) => flags.get(k);
    fleet.store.setFleetFlag = async (_t: string, k: string, v: string) => { flags.set(k, v); };
    fleet.lastDispatchRoutes = [];
    return { fleet, flags };
  }

  it("lists the candidate markets best first and remembers their scores", async () => {
    const { fleet, flags } = scoringFleet();
    fleet.galaxy = { getSystem: () => ({ waypoints: ["X1-S-A", "X1-S-B", "X1-S-C"].map((symbol) => ({ symbol, traits: [{ symbol: "MARKETPLACE" }] })) }) };
    fleet.keeperPriorityMarkets = async () => [];
    fleet.markets = [snap("X1-S-A", ["CHEAP", "CHEAP2", "CHEAP3"]), snap("X1-S-B", ["RICH", "CHEAP", "X"]), snap("X1-S-C", ["CHEAP", "RICH", "Y"])];
    fleet.doctrine = { isEnabledOr: () => true, value: (k: string) => (k === "keeperMinGoods" ? 3 : 5) };
    const r = await fleet.keeperCandidatesForSystem("X1-S");
    assert.equal(r.add.length, 3);
    assert.notEqual(r.add[0], "X1-S-A", "the market with the dear export is not last");
    assert.equal(r.add[2], "X1-S-A", "the market of cheap goods comes last");
    assert.deepEqual(Object.keys(JSON.parse(flags.get("keeperScores")!)).sort(), ["X1-S-A", "X1-S-B", "X1-S-C"]);
  });

  it("keeperReviewData scores stationed keepers from their price rows and lists uncovered markets", async () => {
    const { fleet } = scoringFleet();
    fleet.keeperMarkets = new Map([["K-1", "X1-Z-A"]]);
    fleet.keeperPriorityMarkets = async () => ["X1-Z-A", "X1-Q-B"];
    fleet.keeperPollMs = () => 5 * 60_000;
    const d = await fleet.keeperReviewData();
    assert.equal(d.stationed[0].market, "X1-Z-A");
    assert.ok(d.stationed[0].score > 5, "an export priced 5000 scores at least 5");
    assert.deepEqual(d.uncovered.map((u: any) => u.market), ["X1-Q-B"]);
    assert.equal(d.uncovered[0].score, undefined, "no rows and no remembered score yet");
  });
});

describe("advanceKeeperMarketQueue buys the best-scoring market first", () => {
  it("tries remembered-score markets best first, with unscored operator-listed ones ahead of them, and skips covered ones", async () => {
    const { fleet } = makeFleet({ clauseOn: true, shipsAtYard: [] });
    fleet.store.getFleetFlag = async (_t: string, k: string) => (k === "keeperScores" ? JSON.stringify({ "M-LOW": 1, "M-HIGH": 9, "M-MID": 4, "M-COVERED": 99 }) : undefined);
    fleet.keeperPriorityMarkets = async () => ["M-LOW", "M-HIGH", "M-MANUAL", "M-MID", "M-COVERED"];
    fleet.keeperMarkets = new Map([["K-1", "M-COVERED"]]);
    const asked: string[] = [];
    fleet.maybeRequestKeeperProbeForMarket = async (m: string) => { asked.push(m); return false; };
    await fleet.advanceKeeperMarketQueue();
    assert.deepEqual(asked, ["M-MANUAL", "M-HIGH", "M-MID", "M-LOW"]);
  });
});
