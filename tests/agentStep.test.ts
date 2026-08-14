import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { TraderAgent, type Ship as TraderShip } from "../src/engine/trader.js";
import { ShipAgent, type Ship as AgentShip } from "../src/engine/agent.js";
import { FleetManager } from "../src/engine/fleet.js";
import { IDLE_STEP } from "../src/engine/agentStep.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

/**
 * agentStep.ts: the shared per-agent "what is this ship doing right now"
 * concept. Each test captures `agent.getStep()` *during* the fake api call
 * (the fake method itself reads it before resolving) rather than relying on
 * real timing — deterministic proof the step is set before the real API
 * call and cleared immediately after, not a race against real network
 * latency.
 */

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
    [`AGENTSTEP-${Date.now()}-${Math.random().toString(36).slice(2)}`],
  );
  const id = res.rows[0]!.id;
  tenantIds.push(id);
  return id;
}

function makeTraderShip(symbol = "SHIP-1", waypointSymbol = "X1-A-A1"): TraderShip {
  return {
    symbol,
    // route is always present on a real ShipNav even when docked — waitForArrival() reads it unconditionally.
    nav: { status: "DOCKED", waypointSymbol, systemSymbol: "X1-A", route: { arrival: new Date(0).toISOString(), destination: { symbol: waypointSymbol } } },
    fuel: { current: 100, capacity: 100 },
    cargo: { capacity: 40, units: 0, inventory: [] },
  } as unknown as TraderShip;
}

describe("TraderAgent step tracking", () => {
  it("defaults to idle", () => {
    const trader = new TraderAgent(makeTraderShip(), { api: {} as any });
    assert.deepEqual(trader.getStep(), IDLE_STEP);
  });

  it("navigateTo() reports 'navigating' during the call, idle after", async () => {
    let observed: unknown;
    const trader = new TraderAgent(makeTraderShip(), {
      api: {
        orbitShip: async () => ({ nav: { status: "IN_ORBIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" } }),
        getShip: async () => makeTraderShip(),
        navigateShip: async () => {
          observed = trader.getStep();
          return { nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A", route: { arrival: new Date().toISOString() } }, fuel: { current: 90, capacity: 100 } };
        },
      } as any,
    });

    await (trader as any).navigateTo("X1-A-B2");

    assert.deepEqual(observed, { kind: "navigating", to: "X1-A-B2" });
    assert.deepEqual(trader.getStep(), IDLE_STEP, "must reset to idle once navigation resolves");
  });

  it("navigateTo() resets to idle even when the navigate call throws", async () => {
    const trader = new TraderAgent(makeTraderShip(), {
      api: { navigateShip: async () => { throw new Error("boom"); } } as any,
    });

    await assert.rejects(() => (trader as any).navigateTo("X1-A-B2"));
    assert.deepEqual(trader.getStep(), IDLE_STEP, "the finally block must clear the step regardless of success");
  });

  it("clearLeftoverCargo() reports 'transacting: sell' during the sell call", async () => {
    const ship = makeTraderShip();
    (ship as any).cargo = { capacity: 40, units: 5, inventory: [{ symbol: "IRON_ORE", units: 5 }] };
    let observed: unknown;
    const trader = new TraderAgent(ship, {
      api: {
        sellCargo: async () => {
          observed = trader.getStep();
          return { cargo: { capacity: 40, units: 0, inventory: [] }, transaction: { pricePerUnit: 10, totalPrice: 50 } };
        },
        // getMarket is deliberately unimplemented — liveSellPrice() catches
        // the resulting "not a function" and treats it as "market
        // unreachable," which is exactly the path that lets this test
        // reach the sell call without needing a full market fixture.
      } as any,
    });

    await (trader as any).clearLeftoverCargo();

    assert.deepEqual(observed, { kind: "transacting", action: "sell", good: "IRON_ORE" });
    assert.deepEqual(trader.getStep(), IDLE_STEP);
  });
});

function makeAgentShip(symbol = "SHIP-1"): AgentShip {
  return {
    symbol,
    nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" },
    fuel: { current: 100, capacity: 100 },
    cargo: { capacity: 40, units: 0, inventory: [] },
    mounts: [],
    cooldown: { remainingSeconds: 0 },
  } as unknown as AgentShip;
}

describe("ShipAgent step tracking", () => {
  it("defaults to idle", () => {
    const agent = new ShipAgent(makeAgentShip(), { api: {} as any });
    assert.deepEqual(agent.getStep(), IDLE_STEP);
  });

  it("extractUntilFull() reports 'transacting: extract' during the extract call", async () => {
    const ship = makeAgentShip();
    (ship as any).cargo = { capacity: 40, units: 0, inventory: [] };
    let observed: unknown;
    const agent = new ShipAgent(ship, {
      api: {
        extract: async () => {
          observed = agent.getStep();
          // Fills the hold in one call (cooldown: 0) so the extract loop's
          // own cargoFree()>0 condition exits after exactly one iteration —
          // this test is about the step signal on a single call, not the
          // loop's real multi-extraction behavior.
          return {
            cooldown: { remainingSeconds: 0 },
            extraction: { yield: { symbol: "IRON_ORE", units: 40 } },
            cargo: { capacity: 40, units: 40, inventory: [{ symbol: "IRON_ORE", units: 40 }] },
          };
        },
      } as any,
    });

    await (agent as any).extractUntilFull();

    assert.deepEqual(observed, { kind: "transacting", action: "extract" });
    assert.deepEqual(agent.getStep(), IDLE_STEP);
  });
});

describe("FleetManager.syncShipStates reads real agent step", () => {
  it("a ship whose agent reports 'transacting' persists state='transacting' and the step JSON", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    const agent: any = {
      symbol: "SHIP-1",
      getShip: () => ({ symbol: "SHIP-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] } }),
      isManual: () => false,
      isSuspended: () => false,
      pinnedField: () => undefined,
      getStep: () => ({ kind: "transacting", action: "sell", good: "IRON_ORE" }),
    };
    (fleet as any).traders.set("SHIP-1", agent);

    await (fleet as any).syncShipStates();

    const row = (await store.getAllShipStates(tenantId)).find((s) => s.shipSymbol === "SHIP-1");
    assert.equal(row?.state, "transacting", "transacting must take priority over the nav-status-derived 'docked'");
    assert.deepEqual(row?.step, { kind: "transacting", action: "sell", good: "IRON_ORE" });
  });

  it("target comes from the agent's own reported navigation target while step.kind is 'navigating'", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    const agent: any = {
      symbol: "SHIP-1",
      getShip: () => ({ symbol: "SHIP-1", nav: { status: "IN_TRANSIT", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] } }),
      isManual: () => false,
      isSuspended: () => false,
      pinnedField: () => undefined,
      getStep: () => ({ kind: "navigating", to: "X1-A-Z9" }),
    };
    (fleet as any).traders.set("SHIP-1", agent);

    await (fleet as any).syncShipStates();

    const row = (await store.getAllShipStates(tenantId)).find((s) => s.shipSymbol === "SHIP-1");
    assert.equal(row?.target, "X1-A-Z9");
  });

  it("an agent without getStep() (older/other test fixtures) doesn't crash and is treated as idle", async () => {
    const tenantId = await makeTenant();
    const fleet = new FleetManager({ api: {} as any, store, tenantId });
    const agent: any = {
      symbol: "SHIP-1",
      getShip: () => ({ symbol: "SHIP-1", nav: { status: "DOCKED", waypointSymbol: "X1-A-A1", systemSymbol: "X1-A" }, cargo: { capacity: 40, units: 0, inventory: [] } }),
      isManual: () => false,
      isSuspended: () => false,
      pinnedField: () => undefined,
      // no getStep() at all
    };
    (fleet as any).traders.set("SHIP-1", agent);

    await assert.doesNotReject(() => (fleet as any).syncShipStates());
    const row = (await store.getAllShipStates(tenantId)).find((s) => s.shipSymbol === "SHIP-1");
    assert.equal(row?.state, "docked", "falls back to the nav-status derivation, same as before this change");
    assert.equal(row?.step, undefined);
  });
});
