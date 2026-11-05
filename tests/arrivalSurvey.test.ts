import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { arrivalSurvey } from "../src/engine/arrivalSurvey.js";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

const on = { enabled: true, maxAgeMs: 60 * 60_000 };
const now = 10_000_000;

describe("arrivalSurvey", () => {
  it("surveys a system never surveyed, keepers or not", () => {
    assert.equal(arrivalSurvey({ keepers: 3, now }, on).survey, true);
  });
  it("skips a system our keepers read", () => {
    const v = arrivalSurvey({ surveyedAtMs: now - 5 * 3_600_000, keepers: 2, now }, on);
    assert.equal(v.survey, false);
    assert.match(v.reason, /2 keeper/);
  });
  it("skips a recent survey and repeats a stale one when nothing keeps the system", () => {
    assert.equal(arrivalSurvey({ surveyedAtMs: now - 10 * 60_000, keepers: 0, now }, on).survey, false);
    assert.equal(arrivalSurvey({ surveyedAtMs: now - 90 * 60_000, keepers: 0, now }, on).survey, true);
  });
  it("off surveys every arrival, as before", () => {
    assert.equal(arrivalSurvey({ surveyedAtMs: now - 1, keepers: 9, now }, { enabled: false, maxAgeMs: 0 }).survey, true);
  });
});

/** The seam: FleetManager.jumpShip() surveys only when the rule says so, and always loads the waypoints and gates. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;
const tenantIds: string[] = [];
before(async () => { pool = createPool(DB_URL); store = new Store(pool); });
after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function rig() {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`ARRSURV-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  tenantIds.push(res.rows[0]!.id);
  const ship = { symbol: "S-1", nav: { status: "IN_ORBIT", waypointSymbol: "X1-RB54-AA7A", systemSymbol: "X1-RB54" }, fuel: { current: 100, capacity: 100 }, cargo: { units: 0, capacity: 40, inventory: [] } };
  const api = { onMarket: () => {}, getShip: async () => ship, orbitShip: async () => ({}), jumpShip: async () => ({ transaction: { totalPrice: 5000 }, nav: ship.nav }) };
  const fleet: any = new FleetManager({ api: api as any, store, tenantId: res.rows[0]!.id });
  fleet.galaxy.gatesTo = () => ["X1-RB54-AA7A"];
  fleet.galaxy.verifyGateBeforeJump = async () => "ok";
  const calls = { survey: 0, load: 0, gates: 0 };
  fleet.surveySystem = async () => { calls.survey++; };
  fleet.galaxy.loadSystem = async () => { calls.load++; };
  fleet.galaxy.scanJumpGates = async () => { calls.gates++; };
  fleet.refreshShipCache = async () => {};
  return { fleet, calls };
}

describe("FleetManager.jumpShip: market survey on arrival", () => {
  it("surveys a system it has never surveyed", async () => {
    const { fleet, calls } = await rig();
    await fleet.jumpShip("S-1", "X1-JM97-I57");
    assert.equal(calls.survey, 1);
  });
  it("loads waypoints and gates only, when a keeper is stationed there", async () => {
    const { fleet, calls } = await rig();
    fleet.surveyedAt.set("X1-JM97", Date.now() - 5 * 3_600_000);
    fleet.keeperMarkets.set("K-1", "X1-JM97-A1");
    await fleet.jumpShip("S-1", "X1-JM97-I57");
    assert.deepEqual([calls.survey, calls.load > 0, calls.gates > 0], [0, true, true]);
  });
});
