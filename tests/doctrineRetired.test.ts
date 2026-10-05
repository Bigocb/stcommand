import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Doctrine, RETIRED_POLICIES } from "../src/engine/doctrine.js";

// No Store: these run without a database.
describe("retired doctrine policies (warehousing parked until the gate opens)", () => {
  it("are never enabled and fall back to their unconstrained value", async () => {
    const d = new Doctrine();
    await d.reload();
    for (const key of RETIRED_POLICIES) {
      assert.equal(d.isEnabled(key), false, key);
    }
    assert.equal(d.value("warehouseMax", Infinity), Infinity);
    assert.equal(d.value("warehouseMinMargin", 0), 0);
  });

  it("are hidden from list() and catalog()", async () => {
    const d = new Doctrine();
    await d.reload();
    for (const key of RETIRED_POLICIES) {
      assert.ok(!d.list().some((r) => r.key === key), `${key} in list()`);
      assert.ok(!d.catalog().some((r) => r.key === key), `${key} in catalog()`);
    }
  });

  it("cannot be changed or adopted", async () => {
    const d = new Doctrine();
    await d.reload();
    await assert.rejects(() => d.set("warehouseTarget", { enabled: true }), /retired/);
    await assert.rejects(() => d.setAdopted("warehouseTarget", true), /retired/);
    assert.equal(d.isEnabled("warehouseTarget"), false);
  });

  it("leaves every other rule alone", async () => {
    const d = new Doctrine();
    await d.reload();
    assert.ok(d.list().some((r) => r.key === "cashFloor"));
    assert.equal((await d.set("cashFloor", { value: 30_000 })).value, 30_000);
  });
});
