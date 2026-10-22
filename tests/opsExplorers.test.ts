import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_TOOLS } from "../src/ops/catalog.js";

/** The seam: the ops tool fetches the rows from the store and fleet and hands them to the report builder. */
describe("ops explorers", () => {
  it("builds the report from jumps, survey marks, ship purchases and keeper stations", async () => {
    const asked: Record<string, unknown> = {};
    const w = {
      tenantId: "t1",
      fleet: {
        explorerShips: () => [{ symbol: "E-1", waypoint: "X1-B-G1", nav: "DOCKED", fuel: 100, fuelCap: 200, cooldown: 0, doing: "docked" }],
        keeperStations: () => [{ shipSymbol: "K-1", market: "X1-B-M1" }],
      },
      store: {
        opsMovements: async (_t: string, f: unknown) => { asked.movements = f; return [{ at: new Date("2026-10-22T10:00:00Z"), ship_symbol: "E-1", from_waypoint: "X1-A-G1", to_waypoint: "X1-B-G1", cost: 5000 }]; },
        recentSystemSurveys: async () => [{ systemSymbol: "X1-B", surveyedAt: Date.parse("2026-10-22T10:01:00Z"), markets: 7, shipyards: 1, source: "explore" }],
        systemTradeSpans: async () => [{ system: "X1-B", firstAt: "2026-10-22T09:00:00.000Z", lastAt: "2026-10-22T11:00:00.000Z" }, { system: "X1-C", firstAt: "2026-10-21T00:00:00.000Z", lastAt: "2026-10-21T05:00:00.000Z" }],
        opsLedger: async (_t: string, f: unknown) => { asked.ledger = f; return [{ timestamp: new Date("2026-10-22T10:05:00Z"), ship_symbol: "K-1", waypoint_symbol: "X1-B-Y1", trade_symbol: "SHIP_PROBE", total: 28959 }]; },
      },
    } as any;
    const tool = OPS_TOOLS.find((t) => t.name === "explorers")!;
    const r: any = await tool.run({ w, now: () => Date.parse("2026-10-22T12:00:00Z") } as any, { sinceHours: 72 });

    assert.equal((asked.movements as any).kind, "jump");
    assert.equal((asked.ledger as any).type, "SHIP");
    assert.equal(r.explorers[0].visited[0].system, "X1-B");
    assert.equal(r.explorers[0].visited[0].verdict, "surveyed");
    assert.deepEqual(r.keepers.map((k: any) => [k.ship, k.market, k.price]), [["K-1", "X1-B-M1", 28959]]);
    assert.equal(r.systems[0].keepersStationed, 1);
    assert.deepEqual([r.coverage.trading, r.coverage.tradingLast24h, r.coverage.keepers], [2, 1, 1], "C was last traded 31h ago");
    assert.equal((asked.ledger as any).limit, 2000, "keeper purchases are read for the whole week, not just the window");
  });
});

describe("ops keeper_review", () => {
  it("hands the fleet's keeper data to the review builder", async () => {
    const w = { fleet: { keeperReviewData: async () => ({
      stationed: [{ ship: "K-1", market: "X1-A-M1", score: 1, goods: 2, pollMs: 30 * 60_000 }],
      uncovered: [{ market: "X1-B-M1", score: 10 }],
      max: 300,
    }) } } as any;
    const tool = OPS_TOOLS.find((x) => x.name === "keeper_review")!;
    const r: any = await tool.run({ w, now: () => Date.parse("2026-10-22T12:00:00Z") } as any, {});
    assert.equal(r.budget.room, 299);
    assert.equal(r.swaps[0].scrapShip, "K-1");
    assert.equal(r.next[0].market, "X1-B-M1");
  });
});
