import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ShipRegistry } from "../src/engine/shipRegistry.js";
import { FleetManager } from "../src/engine/fleet.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

describe("ShipRegistry (pure, no Postgres)", () => {
  it("a claim on an unclaimed ship always succeeds", () => {
    const reg = new ShipRegistry();
    const claim = reg.claim("SHIP-1", "auto", "miner", { note: "first" });
    assert.equal(claim?.owner, "auto");
    assert.equal(reg.ownerOf("SHIP-1")?.role, "miner");
  });

  it("a stronger owner can claim over a weaker one without preempt", () => {
    const reg = new ShipRegistry();
    reg.claim("SHIP-1", "auto", "miner");
    const claim = reg.claim("SHIP-1", "operator", "miner");
    assert.equal(claim?.owner, "operator");
    assert.equal(reg.ownerOf("SHIP-1")?.owner, "operator");
  });

  it("a weaker owner is rejected by a stronger existing claim without preempt", () => {
    const reg = new ShipRegistry();
    reg.claim("SHIP-1", "operator", "trader");
    const claim = reg.claim("SHIP-1", "auto", "trader");
    assert.equal(claim, undefined, "claim() must return undefined on rejection");
    assert.equal(reg.ownerOf("SHIP-1")?.owner, "operator", "the existing stronger claim must be untouched");
  });

  it("preempt:true lets a weaker owner override a stronger one anyway", () => {
    const reg = new ShipRegistry();
    reg.claim("SHIP-1", "operator", "trader");
    const claim = reg.claim("SHIP-1", "auto", "trader", {}, { preempt: true });
    assert.equal(claim?.owner, "auto");
  });

  it("the same owner re-claiming always succeeds and preserves `since`", () => {
    const reg = new ShipRegistry();
    const first = reg.claim("SHIP-1", "mission", "trader", { leg: 1 });
    const second = reg.claim("SHIP-1", "mission", "trader", { leg: 2 });
    assert.equal(second?.intent.leg, 2, "intent must update");
    assert.equal(second?.since, first?.since, "since must be preserved across a same-owner re-claim");
  });

  it("respects the full precedence order: operator > mission > warehouse > keeper > auto", () => {
    const order: Array<"operator" | "mission" | "warehouse" | "keeper" | "auto"> = ["operator", "mission", "warehouse", "keeper", "auto"];
    for (let i = 0; i < order.length - 1; i++) {
      const reg = new ShipRegistry();
      const stronger = order[i]!;
      const weaker = order[i + 1]!;
      reg.claim("SHIP-1", stronger, "trader");
      assert.equal(reg.claim("SHIP-1", weaker, "trader"), undefined, `${weaker} must not override ${stronger}`);
      const reg2 = new ShipRegistry();
      reg2.claim("SHIP-1", weaker, "trader");
      assert.notEqual(reg2.claim("SHIP-1", stronger, "trader"), undefined, `${stronger} must override ${weaker}`);
    }
  });

  it("release only clears a claim owned by the releasing owner", () => {
    const reg = new ShipRegistry();
    reg.claim("SHIP-1", "operator", "trader");
    reg.release("SHIP-1", "auto"); // wrong owner — no-op
    assert.equal(reg.ownerOf("SHIP-1")?.owner, "operator");
    reg.release("SHIP-1", "operator");
    assert.equal(reg.ownerOf("SHIP-1"), undefined);
  });

  it("available(forOwner) returns ships forOwner could claim (equal-or-weaker existing owner)", () => {
    const reg = new ShipRegistry();
    reg.claim("AUTO-1", "auto", "miner");
    reg.claim("KEEPER-1", "keeper", "keeper");
    reg.claim("OPERATOR-1", "operator", "trader");
    const forWarehouse = reg.available("warehouse");
    assert.ok(forWarehouse.includes("AUTO-1"));
    assert.ok(forWarehouse.includes("KEEPER-1"));
    assert.ok(!forWarehouse.includes("OPERATOR-1"), "warehouse (rank 2) cannot claim a ship operator (rank 0) already holds");
  });
});

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

async function makeTenant(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO tenants (agent_symbol, token_enc, token_iv) VALUES ($1, '\\x00', '\\x00') RETURNING id`,
    [`SHIPREG-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

describe("ShipRegistry persistence (real Postgres)", () => {
  it("persistDirtyState + loadAllClaims round-trips through Store", async () => {
    const tenantId = await makeTenant();
    const reg = new ShipRegistry();
    reg.claim("SHIP-1", "operator", "trader", { reason: "manual hold" });
    reg.claim("SHIP-2", "auto", "miner");
    await reg.persistDirtyState(tenantId, store);

    const reg2 = new ShipRegistry();
    await reg2.loadAllClaims(tenantId, store);
    assert.equal(reg2.ownerOf("SHIP-1")?.owner, "operator");
    assert.equal(reg2.ownerOf("SHIP-1")?.intent.reason, "manual hold");
    assert.equal(reg2.ownerOf("SHIP-2")?.owner, "auto");
  });

  it("is invisible across tenants, same as every other tenant-scoped table", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await store.recordClaim(tenantA, { shipSymbol: "SHIP-1", owner: "operator", role: "trader", intent: {}, since: new Date().toISOString() });
    assert.equal(await store.getClaim(tenantB, "SHIP-1"), undefined);
    assert.deepEqual(await store.getAllClaims(tenantB), []);
  });

  it("releaseClaim only deletes when the given owner matches, same as ShipRegistry.release()", async () => {
    const tenantId = await makeTenant();
    await store.recordClaim(tenantId, { shipSymbol: "SHIP-1", owner: "operator", role: "trader", intent: {}, since: new Date().toISOString() });
    await store.releaseClaim(tenantId, "SHIP-1", "auto"); // wrong owner
    assert.notEqual(await store.getClaim(tenantId, "SHIP-1"), undefined);
    await store.releaseClaim(tenantId, "SHIP-1", "operator");
    assert.equal(await store.getClaim(tenantId, "SHIP-1"), undefined);
  });
});

/** A minimal stand-in for the agent classes FleetManager holds in its role maps. */
function makeFakeAgent(symbol: string, status: string, manual = false, suspended = false) {
  return {
    symbol,
    getShip: () => ({ symbol, nav: { status, waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] } }),
    isManual: () => manual,
    isSuspended: () => suspended,
    pinnedField: () => undefined,
  };
}

describe("FleetManager.syncShipClaims", () => {
  it("derives owner from role/manual/warehouse/keeper state and persists it", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("MANUAL-1", makeFakeAgent("MANUAL-1", "DOCKED", true));
    (fleet as any).traders.set("WH-1", makeFakeAgent("WH-1", "DOCKED"));
    (fleet as any).warehouseShip = { shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" };
    (fleet as any).keepers.set("KEEPER-1", makeFakeAgent("KEEPER-1", "DOCKED"));
    (fleet as any).miners.set("AUTO-1", makeFakeAgent("AUTO-1", "DOCKED"));

    await (fleet as any).syncShipClaims();

    assert.equal(fleet.shipRegistry.ownerOf("MANUAL-1")?.owner, "operator");
    assert.equal(fleet.shipRegistry.ownerOf("WH-1")?.owner, "warehouse");
    assert.equal(fleet.shipRegistry.ownerOf("KEEPER-1")?.owner, "keeper");
    assert.equal(fleet.shipRegistry.ownerOf("AUTO-1")?.owner, "auto");

    const persisted = await store.getAllClaims(tenantId);
    assert.ok(persisted.some((c) => c.shipSymbol === "MANUAL-1" && c.owner === "operator"));
  });

  it("tags a mission-committed ship's owner as mission", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    (fleet as any).traders.set("CARRIER-1", makeFakeAgent("CARRIER-1", "IN_TRANSIT"));
    (fleet as any).missions.committedShips = () => new Set(["CARRIER-1"]);

    await (fleet as any).syncShipClaims();

    assert.equal(fleet.shipRegistry.ownerOf("CARRIER-1")?.owner, "mission");
  });

  it("a re-sync downgrades a released ship from operator back to auto (preempt in action)", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    const agent = makeFakeAgent("SHIP-1", "DOCKED", true);
    (fleet as any).traders.set("SHIP-1", agent);
    await (fleet as any).syncShipClaims();
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "operator");

    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", "DOCKED", false));
    await (fleet as any).syncShipClaims();
    assert.equal(fleet.shipRegistry.ownerOf("SHIP-1")?.owner, "auto", "releasing manual control must downgrade the mirrored claim, not get stuck");
  });

  it("does nothing when the fleet has no tenantId/store", async () => {
    const fleet = new FleetManager({ api: {} as any });
    (fleet as any).traders.set("SHIP-1", makeFakeAgent("SHIP-1", "DOCKED"));
    await assert.doesNotReject(() => (fleet as any).syncShipClaims());
  });

  it("logs drift when a mission-committed ship's agent isn't actually suspended (Phase 4 detection)", async () => {
    // The cheap alternative to a full Phase 4 rewrite (docs/ship-control-state-audit.md):
    // detect a subsystem driving a ship without having suspended it first —
    // the exact "partial handback" pattern behind every bug this audit
    // started from — without touching any agent's run-loop gating.
    const tenantId = await makeTenant();
    const logs: string[] = [];
    const fleet = new FleetManager({ api: {} as any, store, tenantId, log: (m) => logs.push(m) });
    (fleet as any).traders.set("CARRIER-1", makeFakeAgent("CARRIER-1", "IN_TRANSIT", false, false));
    (fleet as any).missions.committedShips = () => new Set(["CARRIER-1"]);

    await (fleet as any).syncShipClaims();

    assert.ok(logs.some((m) => m.includes("ship control drift") && m.includes("CARRIER-1")), "must log a drift warning for a mission-owned ship that isn't suspended");
  });

  it("does not log drift when a mission-committed ship's agent is properly suspended", async () => {
    const tenantId = await makeTenant();
    const logs: string[] = [];
    const fleet = new FleetManager({ api: {} as any, store, tenantId, log: (m) => logs.push(m) });
    (fleet as any).traders.set("CARRIER-1", makeFakeAgent("CARRIER-1", "IN_TRANSIT", false, true));
    (fleet as any).missions.committedShips = () => new Set(["CARRIER-1"]);

    await (fleet as any).syncShipClaims();

    assert.ok(!logs.some((m) => m.includes("ship control drift")), "a properly-suspended mission carrier must not be flagged");
  });
});
