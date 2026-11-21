import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { slimShip, StateBodyCache } from "../src/http/stateBody.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

const ship = {
  symbol: "S-1",
  registration: { role: "HAULER" },
  frame: { symbol: "FRAME_HEAVY_FREIGHTER", name: "Heavy", condition: 0.9, description: "x".repeat(400), requirements: { power: 1 } },
  reactor: { symbol: "REACTOR", name: "R", condition: 1, description: "long" },
  engine: { symbol: "ENGINE", name: "E", condition: 1, description: "long", requirements: { crew: 2 } },
  modules: [{ symbol: "MODULE_CARGO_HOLD_II", name: "Hold", capacity: 40, description: "long", requirements: { slots: 1 } }],
  mounts: [{ symbol: "MOUNT_SURVEYOR_I", name: "Surveyor", strength: 1, description: "long" }],
  crew: { current: 5, capacity: 10 },
  cargo: { capacity: 225, units: 0, inventory: [] },
  nav: { status: "DOCKED", waypointSymbol: "X1-A-1" },
};

describe("slimShip", () => {
  it("drops part descriptions and requirements, keeps every field a screen reads", () => {
    const s = slimShip(ship) as typeof ship;
    assert.equal((s.frame as any).description, undefined);
    assert.equal((s.frame as any).requirements, undefined);
    assert.deepEqual([s.frame.symbol, s.frame.name, s.frame.condition], ["FRAME_HEAVY_FREIGHTER", "Heavy", 0.9]);
    assert.deepEqual([s.modules[0]!.symbol, s.modules[0]!.name, s.modules[0]!.capacity], ["MODULE_CARGO_HOLD_II", "Hold", 40]);
    assert.equal((s.modules[0] as any).description, undefined);
    assert.equal(s.mounts[0]!.strength, 1);
    assert.deepEqual(s.crew, ship.crew);
    assert.deepEqual(s.cargo, ship.cargo);
    assert.ok(JSON.stringify(s).length < JSON.stringify(ship).length / 2);
    assert.equal((ship.frame as any).description.length, 400, "the original is not touched");
  });
});

describe("StateBodyCache", () => {
  it("builds once for the same snapshot within the age, rebuilds on a new snapshot or when too old", async () => {
    const c = new StateBodyCache(10_000);
    let builds = 0;
    const build = async () => { builds += 1; return { n: builds }; };
    const snapA = {};
    const [a, b] = await Promise.all([c.get("t|lean", snapA, build, 1000), c.get("t|lean", snapA, build, 1000)]);
    assert.equal(builds, 1, "concurrent misses share one build");
    assert.equal(a, b);
    assert.equal(gunzipSync(a.gzipped).toString(), a.text);
    await c.get("t|lean", snapA, build, 5000);
    assert.equal(builds, 1, "same snapshot, young: cached");
    await c.get("t|lean", {}, build, 5000);
    assert.equal(builds, 2, "a new snapshot rebuilds");
    const snapB = {};
    await c.get("t|full", snapB, build, 5000);
    await c.get("t|full", snapB, build, 20_000);
    assert.equal(builds, 4, "older than the age rebuilds");
  });
  it("a failed build is not kept", async () => {
    const c = new StateBodyCache();
    const snap = {};
    await assert.rejects(c.get("k", snap, async () => { throw new Error("x"); }, 0));
    await new Promise((r) => setImmediate(r));
    assert.equal(c.size(), 0);
  });
});

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

describe("Store.tradeLegs prefilter (clause tradeLegsPrefilter)", () => {
  const pool = createPool(DB_URL);
  const store = new Store(pool);
  const tag = `LEGT${Date.now() % 100000}`;
  const sys = (n: number) => `X1-${tag}${n}`;
  before(async () => {
    const rows: [string, string, string, number, number][] = [
      // GOOD_A: buy cheap at 1-A, sells at 1-B, 2-A, 2-B, 3-A (3 is outside the allowed systems)
      [sys(1), `${sys(1)}-A`, `${tag}_A`, 100, 90],
      [sys(1), `${sys(1)}-B`, `${tag}_A`, 300, 200],
      [sys(2), `${sys(2)}-A`, `${tag}_A`, 400, 300],
      [sys(2), `${sys(2)}-B`, `${tag}_A`, 500, 400],
      [sys(3), `${sys(3)}-A`, `${tag}_A`, 900, 800],
      // GOOD_B (to be excluded)
      [sys(1), `${sys(1)}-A`, `${tag}_B`, 10, 9],
      [sys(2), `${sys(2)}-A`, `${tag}_B`, 50, 40],
    ];
    for (const [s, wp, good, buy, sell] of rows) {
      await pool.query(
        `INSERT INTO market_latest (system_symbol, waypoint_symbol, good_symbol, type, supply, purchase_price, sell_price, trade_volume, activity, timestamp)
         VALUES ($1,$2,$3,'EXCHANGE','MODERATE',$4,$5,60,NULL,now())`,
        [s, wp, good, buy, sell],
      );
    }
  });
  after(async () => { await pool.query("DELETE FROM market_latest WHERE good_symbol LIKE $1", [`${tag}%`]); await pool.end(); });
  const mine = (legs: { goodSymbol: string }[]) => legs.filter((l) => l.goodSymbol.startsWith(tag));

  it("off: the plain join, unchanged", async () => {
    const legs = mine(await store.tradeLegs(90, 360));
    assert.ok(legs.some((l) => l.sellAt === `${sys(3)}-A`));
    assert.ok(legs.some((l) => l.goodSymbol === `${tag}_B`));
  });
  it("on: only allowed systems, excluded goods left out, top N sell markets per good and buy market", async () => {
    const legs = mine(await store.tradeLegs(90, 360, { systems: [sys(1), sys(2)], excludeGoods: [`${tag}_B`], topSellsPerBuy: 2 }));
    assert.ok(!legs.some((l) => l.buySystem === sys(3) || l.sellSystem === sys(3)), "system 3 is out");
    assert.ok(!legs.some((l) => l.goodSymbol === `${tag}_B`), "excluded good is out");
    const fromA = legs.filter((l) => l.buyAt === `${sys(1)}-A`).map((l) => l.sellAt).sort();
    assert.deepEqual(fromA, [`${sys(2)}-A`, `${sys(2)}-B`], "the two best sell prices from 1-A");
    assert.equal(typeof legs[0]!.stalestMs, "number");
  });
});
