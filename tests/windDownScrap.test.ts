import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCRAP_DEADLINE_MIN, WindDownScrapper, shouldRetire, shipsToRetire } from "../src/engine/windDownScrap.js";
import type { ShipRole } from "../src/engine/shipRegistry.js";

const NOBODY = new Set<string>();

describe("shipsToRetire", () => {
  it("picks a keeper", () => {
    assert.deepEqual(shipsToRetire([{ symbol: "THEO-1", role: "keeper" }], NOBODY, 10), ["THEO-1"]);
  });

  it("never picks a trader — traders are retired by the sell rule instead", () => {
    assert.deepEqual(shipsToRetire([{ symbol: "THEO-9", role: "trader" }], NOBODY, 10), []);
  });

  /**
   * Every role that is not a trader retires at the window, not just the two this week's fleet
   * happens to be made of. Written as a sweep over the union so that adding a role to ShipRole
   * without deciding what wind-down should do with it shows up here rather than in production.
   */
  it("picks every non-trader role there is", () => {
    const everyRole: ShipRole[] = ["miner", "trader", "surveyor", "tour", "keeper", "scout", "siphoner", "explorer", "warehouse", "idle"];
    const fleet = everyRole.map((role, i) => ({ symbol: `THEO-${i}`, role }));
    const picked = shipsToRetire(fleet, NOBODY, 99);

    assert.equal(picked.length, everyRole.length - 1, "every role but trader");
    for (const [i, role] of everyRole.entries()) {
      if (role === "trader") assert.ok(!picked.includes(`THEO-${i}`), "a trader must not be picked at the window");
      else assert.ok(picked.includes(`THEO-${i}`), `${role} should be retired at the window`);
    }
  });

  it("skips ships already queued or already flying to a yard, so nothing is retired twice", () => {
    const queued = new Set(["THEO-1"]);
    assert.deepEqual(shipsToRetire([{ symbol: "THEO-1", role: "keeper" }, { symbol: "THEO-2", role: "keeper" }], queued, 10), ["THEO-2"]);
  });

  it("honours the per-tick limit", () => {
    const fleet = ["A", "B", "C", "D", "E"].map((s) => ({ symbol: s, role: "keeper" }));
    assert.deepEqual(shipsToRetire(fleet, NOBODY, 2), ["A", "B"]);
  });

  it("returns nothing for an empty fleet", () => {
    assert.deepEqual(shipsToRetire([], NOBODY, 5), []);
  });
});

describe("shouldRetire", () => {
  it("retires an empty ship well before the deadline", () => {
    const d = shouldRetire(0, 90);
    assert.equal(d.retire, true);
    assert.match(d.reason, /hold is empty/);
  });

  it("waits for a loaded ship, so its cargo is sold rather than destroyed", () => {
    const d = shouldRetire(80, 90);
    assert.equal(d.retire, false);
    assert.match(d.reason, /waiting for its own sale/);
  });

  it("gives up waiting exactly at the deadline and scraps the cargo with it", () => {
    const d = shouldRetire(80, SCRAP_DEADLINE_MIN);
    assert.equal(d.retire, true);
    assert.match(d.reason, /deadline/);
    assert.match(d.reason, /80 unit\(s\) aboard/);
  });

  it("still scraps a loaded ship inside the deadline", () => {
    assert.equal(shouldRetire(80, SCRAP_DEADLINE_MIN - 1).retire, true);
  });

  it("retires past the reset rather than queueing forever", () => {
    assert.equal(shouldRetire(0, -5).retire, true);
  });
});

describe("WindDownScrapper", () => {
  const scrapper = (): WindDownScrapper => new WindDownScrapper();

  it("records a ship whose sale emptied its hold", () => {
    const s = scrapper();
    s.onShipActionDone(1, "THEO-1", "sell", { cargo: { units: 0, inventory: [] } });
    assert.deepEqual(s.take(), ["THEO-1"]);
  });

  it("ignores a partial sale that left cargo aboard", () => {
    const s = scrapper();
    s.onShipActionDone(1, "THEO-1", "sell", { cargo: { units: 40, inventory: [{ symbol: "IRON", units: 40 }] } });
    assert.deepEqual(s.take(), []);
  });

  it("ignores every action that is not a sale", () => {
    const s = scrapper();
    for (const action of ["dock", "orbit", "jump", "refuel", "navigate", "extract", "transfer"]) {
      s.onShipActionDone(1, "THEO-1", action, { cargo: { units: 0 } });
    }
    assert.deepEqual(s.take(), []);
  });

  it("ignores a response with no cargo at all rather than assuming it is empty", () => {
    const s = scrapper();
    s.onShipActionDone(1, "THEO-1", "sell", { transaction: { units: 10 } });
    s.onShipActionDone(1, "THEO-1", "sell", undefined);
    assert.deepEqual(s.take(), []);
  });

  it("ignores a response that names no ship", () => {
    const s = scrapper();
    s.onShipActionDone(1, undefined, "sell", { cargo: { units: 0 } });
    assert.deepEqual(s.take(), []);
  });

  it("empties on take, so a ship is only handed over once", () => {
    const s = scrapper();
    s.onShipActionDone(1, "THEO-1", "sell", { cargo: { units: 0 } });
    assert.deepEqual(s.take(), ["THEO-1"]);
    assert.deepEqual(s.take(), []);
  });

  it("reports several ships sold in the same window once each", () => {
    const s = scrapper();
    s.onShipActionDone(1, "THEO-1", "sell", { cargo: { units: 0 } });
    s.onShipActionDone(2, "THEO-2", "sell", { cargo: { units: 0 } });
    s.onShipActionDone(3, "THEO-1", "sell", { cargo: { units: 0 } });
    assert.deepEqual(s.take().sort(), ["THEO-1", "THEO-2"]);
  });
});
