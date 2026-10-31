import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipRegistry } from "../src/engine/shipRegistry.js";

/**
 * persistDirtyState() used to write every claim on every tick, each in its own transaction (544 ships, about 2.9 s of every core pass on
 * 2026-10-31). It now writes only claims that changed since they were saved. A fake store counts the writes: no database needed.
 */
function fakeStore(failFor?: string) {
  const writes: string[] = [];
  const batches: string[][] = [];
  const store = {
    recordClaims: async (_t: string, cs: { shipSymbol: string }[]) => {
      if (failFor && cs.some((c) => c.shipSymbol === failFor)) throw new Error("db down");
      batches.push(cs.map((c) => c.shipSymbol));
      for (const c of cs) writes.push(c.shipSymbol);
    },
    getAllClaims: async () => [{ shipSymbol: "OLD-1", owner: "keeper", role: "keeper", intent: { status: "DOCKED" }, since: "2026-10-31T00:00:00.000Z" }],
  } as any;
  return { store, writes, batches };
}

describe("ShipRegistry.persistDirtyState", () => {
  it("writes a claim once, and again only when its owner, role, intent or since changes", async () => {
    const { store, writes, batches } = fakeStore();
    const reg = new ShipRegistry();
    reg.claim("S-1", "auto", "trader", { status: "DOCKED" });
    reg.claim("S-2", "keeper", "keeper", { status: "DOCKED" });
    await reg.persistDirtyState("t", store);
    assert.deepEqual(writes, ["S-1", "S-2"]);
    assert.equal(batches.length, 1, "both claims go in one batch, not one transaction each");
    await reg.persistDirtyState("t", store);
    reg.claim("S-1", "auto", "trader", { status: "DOCKED" }, { preempt: true });
    await reg.persistDirtyState("t", store);
    assert.deepEqual(writes, ["S-1", "S-2"], "same claim again: nothing written");
    reg.claim("S-1", "auto", "trader", { status: "IN_TRANSIT" }, { preempt: true });
    reg.claim("S-2", "operator", "keeper", {}, { preempt: true });
    await reg.persistDirtyState("t", store);
    assert.deepEqual(writes, ["S-1", "S-2", "S-1", "S-2"]);
  });

  it("a failed write is not marked saved, so the next tick tries it again", async () => {
    const bad = fakeStore("S-1");
    const reg = new ShipRegistry();
    reg.claim("S-1", "auto", "trader");
    await assert.rejects(reg.persistDirtyState("t", bad.store));
    const good = fakeStore();
    await reg.persistDirtyState("t", good.store);
    assert.deepEqual(good.writes, ["S-1"]);
  });

  it("claims loaded from the store count as saved", async () => {
    const { store, writes } = fakeStore();
    const reg = new ShipRegistry();
    await reg.loadAllClaims("t", store);
    await reg.persistDirtyState("t", store);
    assert.deepEqual(writes, [], "nothing changed since the load");
  });
});
