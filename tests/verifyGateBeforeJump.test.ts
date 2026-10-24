import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { GalaxyAtlas } from "../src/engine/galaxy.js";
import { TraderAgent, type Ship } from "../src/engine/trader.js";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/** A live read of the gate just before a jump (GalaxyAtlas.verifyGateBeforeJump): catches a gate wrongly recorded complete. */

function atlasWith(answers: (url: string) => Response | Promise<Response>) {
  const atlas: any = new GalaxyAtlas({} as any);
  const urls: string[] = [];
  atlas.publicFetch = async (u: URL) => { urls.push(String(u)); return answers(String(u)); };
  return { atlas, urls };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

describe("GalaxyAtlas.verifyGateBeforeJump", () => {
  it("a finished gate is ok, read once, and trusted afterwards", async () => {
    const { atlas, urls } = atlasWith(() => json({ isComplete: true, materials: [] }));
    assert.equal(await atlas.verifyGateBeforeJump("X1-RB54-AA7A"), "ok");
    assert.equal(await atlas.verifyGateBeforeJump("X1-RB54-AA7A"), "ok");
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /\/systems\/X1-RB54\/waypoints\/X1-RB54-AA7A\/construction$/);
  });

  it("an unfinished gate recorded complete is corrected in the cache and reported unfinished (JM97)", async () => {
    const { atlas } = atlasWith(() => json({ isComplete: false, materials: [{ tradeSymbol: "FAB_MATS", required: 1600, fulfilled: 0 }] }));
    atlas.gateConstruction.set("X1-JM97-I57", true);
    assert.equal(await atlas.verifyGateBeforeJump("X1-JM97-I57"), "unfinished");
    assert.equal(atlas.gateComplete("X1-JM97-I57"), false, "the wrong 'complete' is gone");
    assert.equal(await atlas.verifyGateBeforeJump("X1-JM97-I57"), "unfinished", "still read live next time, not cached as ok");
  });

  it("no answer means unknown, never ok: a 404, a 500, bad JSON and a network error all let the game decide", async () => {
    for (const answer of [() => new Response("{}", { status: 404 }), () => new Response("{}", { status: 500 }), () => new Response("not json", { status: 200 }), () => { throw new Error("offline"); }]) {
      const { atlas } = atlasWith(answer as any);
      assert.equal(await atlas.verifyGateBeforeJump("X1-A-G"), "unknown");
      assert.equal(atlas.gateComplete("X1-A-G"), undefined, "nothing is written on no answer");
    }
  });

  it("a 429 pauses verification for a minute instead of piling more reads on", async () => {
    const { atlas, urls } = atlasWith(() => new Response("{}", { status: 429 }));
    assert.equal(await atlas.verifyGateBeforeJump("X1-A-G"), "unknown");
    assert.equal(await atlas.verifyGateBeforeJump("X1-B-G"), "unknown");
    assert.equal(urls.length, 1, "the second gate was not even asked");
  });

  it("two ships at the same gate at the same moment share one read", async () => {
    const { atlas, urls } = atlasWith(async () => { await new Promise((r) => setTimeout(r, 10)); return json({ isComplete: true }); });
    const [a, b] = await Promise.all([atlas.verifyGateBeforeJump("X1-A-G"), atlas.verifyGateBeforeJump("X1-A-G")]);
    assert.deepEqual([a, b], ["ok", "ok"]);
    assert.equal(urls.length, 1);
  });
});

describe("the check at the trader's jump", () => {
  it("does not jump into a gate the live read says is unfinished, retires the route, and says why", async () => {
    const ship = {
      symbol: "T-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-RB54-AA7A", systemSymbol: "X1-RB54", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 40, units: 0, inventory: [] }, fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    let jumped = 0;
    const atlas = {
      gatesTo: () => ["X1-RB54-AA7A"],
      loadSystem: async () => ({ symbol: "X1-JM97", waypoints: [{ symbol: "X1-JM97-I57", type: "JUMP_GATE" }], jumpGates: [], markets: [], shipyards: [] }),
      verifyGateBeforeJump: async (g: string) => (g === "X1-JM97-I57" ? "unfinished" : "ok"),
      recordGateNotComplete: () => {},
    };
    const assigned = { good: "CLOTHING", role: "direct", buyAt: "X1-RB54-A1", sellAt: "X1-JM97-A1", buyPrice: 1, sellPrice: 2 };
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship, orbitShip: async () => ({ nav: ship.nav }), jumpShip: async () => { jumped++; return {} as any; } } as any,
      log: () => {}, atlas: atlas as any, assignedRoute: () => assigned,
    } as any);
    (trader as any).navigateTo = async () => {};
    (trader as any).topOffHere = async () => {};
    await assert.rejects(() => (trader as any).jumpToSystem("X1-JM97", "X1-JM97-A1"), /Destination jump gate X1-JM97-I57 is under construction \(checked live before jumping\)/);
    assert.equal(jumped, 0, "no jump was attempted, so none was paid for or rejected");
    assert.ok((trader as any).deadRoutes.has("CLOTHING@X1-RB54-A1"), "the route to that system is retired");
  });

  it("an atlas without the check (older stubs) jumps as before", async () => {
    const ship = {
      symbol: "T-1",
      nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-GATE", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date().toISOString() } },
      cargo: { capacity: 40, units: 0, inventory: [] }, fuel: { current: 400, capacity: 400 }, cooldown: { remainingSeconds: 0 }, mounts: [], modules: [],
    } as unknown as Ship;
    const calls: string[] = [];
    const trader = new TraderAgent(ship, {
      api: { getCallCount: () => 0, getShip: async () => ship, orbitShip: async () => ({ nav: ship.nav }),
        jumpShip: async (_s: string, wp: string) => { calls.push(wp); return { nav: { status: "IN_ORBIT", waypointSymbol: wp, systemSymbol: "X1-B" }, cooldown: { remainingSeconds: 0 }, transaction: { totalPrice: 1 }, agent: {} } as any; } } as any,
      log: () => {},
      atlas: { gatesTo: () => ["X1-A-GATE"], loadSystem: async () => ({ symbol: "X1-B", waypoints: [{ symbol: "X1-B-GATE", type: "JUMP_GATE" }], jumpGates: [], markets: [], shipyards: [] }), recordJumpCost: () => {} } as any,
    } as any);
    (trader as any).navigateTo = async () => {};
    (trader as any).topOffHere = async () => {};
    await (trader as any).jumpToSystem("X1-B", "X1-B-GATE");
    assert.deepEqual(calls, ["X1-B-GATE"]);
  });
});

describe("the check at the operator jump (FleetManager.jumpShip)", () => {
  const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
  let pool: pg.Pool;
  let store: Store;
  const tenantIds: string[] = [];
  before(async () => { pool = createPool(DB_URL); store = new Store(pool); });
  after(async () => {
    if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
    await pool.end();
  });

  it("refuses before calling the game when the destination gate is unfinished", async () => {
    const res = await pool.query<{ id: string }>(`INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`, [`VERIFYJUMP-${Date.now()}-${Math.random().toString(36).slice(2)}`]);
    const tenantId = res.rows[0]!.id;
    tenantIds.push(tenantId);
    const ship = { symbol: "S-1", nav: { status: "IN_ORBIT", waypointSymbol: "X1-RB54-AA7A", systemSymbol: "X1-RB54" }, fuel: { current: 100, capacity: 100 }, cargo: { units: 0, capacity: 40, inventory: [] } };
    let jumped = 0;
    const api = { onMarket: () => {}, getShip: async () => ship, orbitShip: async () => ({}), jumpShip: async () => { jumped++; return {}; } };
    const fleet: any = new FleetManager({ api: api as any, store, tenantId });
    fleet.galaxy.gatesTo = () => ["X1-RB54-AA7A"];
    fleet.galaxy.verifyGateBeforeJump = async (g: string) => (g === "X1-JM97-I57" ? "unfinished" : "ok");
    await assert.rejects(() => fleet.jumpShip("S-1", "X1-JM97-I57"), /Destination jump gate X1-JM97-I57 is under construction \(checked live before jumping\)/);
    assert.equal(jumped, 0);
  });
});
