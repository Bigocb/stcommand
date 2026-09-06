import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type Ship } from "../src/engine/agent.js";
import { Registry } from "../src/engine/registry.js";

/**
 * The cargo-residue deadlock that stopped the DRAGOM fleet dead for
 * ninety-five minutes.
 *
 * A mining ship extracts whatever the asteroid yields. At X1-S84-EC5D that
 * was iron, copper and aluminium ore — all sellable at X1-S84-H56 — mixed
 * with quartz sand, ice water and silicon crystals, none of which H56 lists.
 * Roughly half of everything mined had no buyer there.
 *
 * sellAllCargo() catches each rejection ("Trade good SILICON_CRYSTALS is not
 * listed at market X1-S84-H56") and moves on, so the unsellable half stayed
 * aboard after every trip and nothing ever removed it. Two failures then
 * compounded:
 *
 *   - pickSellTarget() read inventory[0] only, so once residue reached the
 *     front of the hold the ship stopped seeing the sellable ore behind it
 *   - there was no disposal path at all, so a good with no reachable buyer
 *     held its slot permanently
 *
 * Sales decayed 12 → 9 → 5 → 1 → 0 and all four miners sat at a full hold,
 * re-mining into it every eight seconds, until they were restarted.
 */

const SELLABLE = "IRON_ORE";
const RESIDUE = "QUARTZ_SAND";

/** A system with one market that buys IRON_ORE and does not list QUARTZ_SAND. */
function world(): Registry {
  const r = Registry.standalone();
  r.seed([
    { symbol: "X1-A-EC5D", x: 0, y: 0 },   // the asteroid
    { symbol: "X1-A-H56", x: 3, y: 4 },    // 5 units away — well inside an 80 tank
  ]);
  r.recordMarket({
    symbol: "X1-A-H56",
    systemSymbol: "X1-A",
    imports: [SELLABLE],
    exports: [],
    exchange: [],
    tradeGoods: { [SELLABLE]: { symbol: SELLABLE, type: "IMPORT", sellPrice: 61, purchasePrice: 70, tradeVolume: 40 } },
    fetchedAt: new Date().toISOString(),
  } as never);
  return r;
}

function miner(inventory: { symbol: string; units: number }[], opts: Record<string, unknown> = {}) {
  const units = inventory.reduce((n, i) => n + i.units, 0);
  const ship = {
    symbol: "MINER-1",
    nav: { status: "DOCKED", waypointSymbol: "X1-A-EC5D", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
    cargo: { capacity: 15, units, inventory },
    fuel: { current: 80, capacity: 80 },
    cooldown: { remainingSeconds: 0 },
    mounts: [], modules: [],
  } as unknown as Ship;
  const agent = new ShipAgent(ship, { api: { getCallCount: () => 0 }, ...opts } as never);
  (agent as never as { withRegistry(r: Registry): unknown }).withRegistry(world());
  return agent;
}

describe("pickSellTarget considers the whole hold, not just its first slot", () => {
  it("finds the buyer for a sellable good sitting behind unsellable residue", () => {
    // The exact shape that bricked the fleet: residue first, ore behind it.
    const agent = miner([{ symbol: RESIDUE, units: 8 }, { symbol: SELLABLE, units: 7 }]);
    assert.equal(
      (agent as never as { pickSellTarget(): string | undefined }).pickSellTarget(),
      "X1-A-H56",
      "reading inventory[0] alone is what made a ship carrying 7u of saleable ore believe it had nowhere to go",
    );
  });

  it("still returns nothing when the entire hold is unsellable", () => {
    const agent = miner([{ symbol: RESIDUE, units: 15 }]);
    assert.equal((agent as never as { pickSellTarget(): string | undefined }).pickSellTarget(), undefined);
  });

  it("ignores goods reserved for a contract when choosing where to go", () => {
    const agent = miner([{ symbol: SELLABLE, units: 7 }], { protectedGoods: () => new Set([SELLABLE]) });
    assert.equal(
      (agent as never as { pickSellTarget(): string | undefined }).pickSellTarget(),
      undefined,
      "flying to a market to sell cargo that must not be sold is a wasted trip",
    );
  });
});

describe("dumpUnsellableCargo breaks the deadlock", () => {
  function spyMiner(inventory: { symbol: string; units: number }[], opts: Record<string, unknown> = {}) {
    const jettisoned: { good: string; units: number }[] = [];
    const units = inventory.reduce((n, i) => n + i.units, 0);
    const ship = {
      symbol: "MINER-1",
      nav: { status: "DOCKED", waypointSymbol: "X1-A-EC5D", systemSymbol: "X1-A", flightMode: "CRUISE", route: { arrival: new Date(0).toISOString() } },
      cargo: { capacity: 15, units, inventory },
      fuel: { current: 80, capacity: 80 },
      cooldown: { remainingSeconds: 0 },
      mounts: [], modules: [],
    } as unknown as Ship;
    const agent = new ShipAgent(ship, {
      api: {
        getCallCount: () => 0,
        jettisonCargo: async (_s: string, good: string, n: number) => { jettisoned.push({ good, units: n }); },
        getShip: async () => ship,
      },
      ...opts,
    } as never);
    (agent as never as { withRegistry(r: Registry): unknown }).withRegistry(world());
    return { agent, jettisoned };
  }

  const dump = (agent: unknown) => (agent as { dumpUnsellableCargo(): Promise<boolean> }).dumpUnsellableCargo();

  it("throws the residue overboard when it has crowded out the hold", async () => {
    const { agent, jettisoned } = spyMiner([{ symbol: RESIDUE, units: 15 }]);
    assert.equal(await dump(agent), true);
    assert.deepEqual(jettisoned, [{ good: RESIDUE, units: 15 }]);
  });

  it("leaves a part-empty hold alone — listings change, and carrying it is free", async () => {
    const { agent, jettisoned } = spyMiner([{ symbol: RESIDUE, units: 3 }]);
    assert.equal(await dump(agent), false, "3 of 15 is not crowding anything");
    assert.deepEqual(jettisoned, []);
  });

  it("never jettisons anything a market will actually buy", async () => {
    const { agent, jettisoned } = spyMiner([{ symbol: SELLABLE, units: 8 }, { symbol: RESIDUE, units: 7 }]);
    await dump(agent);
    assert.deepEqual(jettisoned, [{ good: RESIDUE, units: 7 }], "the ore has a buyer at H56 and must survive");
  });

  it("never jettisons contract or mission cargo, however full the hold", async () => {
    // Reserved goods have no market by design — that is the normal case for
    // a contract good, and destroying it would throw away the delivery the
    // fleet is being paid for.
    const { agent, jettisoned } = spyMiner(
      [{ symbol: "DRUGS", units: 15 }],
      { protectedGoods: () => new Set(["DRUGS"]) },
    );
    assert.equal(await dump(agent), false);
    assert.deepEqual(jettisoned, []);
  });
});
