import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/** The operator/hop jump path (FleetManager.jumpShip) corrects the construction cache from a live rejection, on the gate the game names. */

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;
const tenantIds: string[] = [];

before(async () => {
  pool = createPool(DB_URL);
  store = new Store(pool);
});

after(async () => {
  if (tenantIds.length) await pool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await pool.end();
});

async function rig(rejection: string) {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`JUMPREJ-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const tenantId = res.rows[0]!.id;
  tenantIds.push(tenantId);
  const ship = { symbol: "S-1", nav: { status: "IN_ORBIT", waypointSymbol: "X1-RB54-AA7A", systemSymbol: "X1-RB54" }, fuel: { current: 100, capacity: 100 }, cargo: { units: 0, capacity: 40, inventory: [] } };
  const api = { onMarket: () => {}, getShip: async () => ship, orbitShip: async () => ({}), jumpShip: async () => { throw new Error(rejection); } };
  const fleet: any = new FleetManager({ api: api as any, store, tenantId });
  const flagged: string[] = [];
  fleet.galaxy.gatesTo = () => ["X1-RB54-AA7A"];
  fleet.galaxy.recordGateNotComplete = (g: string) => { flagged.push(g); };
  fleet.galaxy.verifyGateBeforeJump = async () => "unknown"; // the pre-jump live read is tested in verifyGateBeforeJump.test.ts; no network here
  return { fleet, flagged };
}

describe("FleetManager.jumpShip: a live rejection corrects the cache", () => {
  it("flags the destination gate named in an 'under construction' rejection, and rethrows", async () => {
    const { fleet, flagged } = await rig("Failed to execute jump. Destination jump gate X1-JM97-I57 is under construction.");
    await assert.rejects(() => fleet.jumpShip("S-1", "X1-JM97-I57"), /under construction/);
    assert.deepEqual(flagged, ["X1-JM97-I57"]);
  });

  it("does not close a gate on a routing error ('not connected'), as this path never did", async () => {
    const { fleet, flagged } = await rig("Failed to execute jump. Waypoint X1-JM97-I57 is not connected to the current location");
    await assert.rejects(() => fleet.jumpShip("S-1", "X1-JM97-I57"), /not connected/);
    assert.deepEqual(flagged, []);
  });
});
