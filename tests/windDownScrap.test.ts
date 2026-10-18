import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/**
 * The wiring, checked where it can fail silently.
 *
 * fleet.ts installs its observers through one conditional expression — the sweep board only when the
 * sweep runs, the ship book always. A new observer added to only one branch is disabled the moment the
 * other branch is taken, and nothing anywhere would say so: the only reader of WindDownScrapper's queue
 * is retireNonTraders(), so a dropped observer looks exactly like a fleet with nothing to retire.
 * tests/scrapWiring.test.ts guards the same class of mistake for scrapHere, for the same reason.
 */
describe("fleet.ts wiring", () => {
  const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");

  it("passes the scrapper to combineShipObservers in every branch of the sweep conditional", () => {
    const call = /this\.api\.setShipObserver\?\.\(([\s\S]*?)\);/.exec(src);
    assert.ok(call, "setShipObserver call not found — did fleet.ts move it?");
    // Split the ternary explicitly. Slicing only on "?" leaves BOTH branches in the tail, and a regex
    // then happily matches the branch it was not aimed at — a version of this test passed against a
    // deliberately-broken sweep-on branch until it was written this way.
    const body = call[1]!;
    const q = body.indexOf("?");
    const colon = body.indexOf(":", q);
    assert.ok(q > -1 && colon > q, "expected a ternary in the setShipObserver argument");
    const sweepOn = body.slice(q + 1, colon);
    const sweepOff = body.slice(colon + 1);
    assert.match(sweepOn, /combineShipObservers\([^)]*windDownScrapper/, "sweep-on branch is missing the scrapper");
    assert.match(sweepOff, /combineShipObservers\([^)]*windDownScrapper/, "sweep-off branch is missing the scrapper");
  });

  it("drains the scrapper from the tick, not from a request path", () => {
    assert.match(src, /await this\.timed\("retireNonTraders", \(\) => this\.retireNonTraders\(\)\)/, "retireNonTraders is not called from the tick");
    assert.match(src, /this\.windDownScrapper\.take\(\)/, "nothing drains the scrapper's queue");
  });

  it("retires through sellShip(), the same path the operator's Sell button uses", () => {
    const body = /private async retireNonTraders\(\)[\s\S]*?\n  \}/.exec(src);
    assert.ok(body, "retireNonTraders not found");
    assert.match(body[0], /await this\.sellShip\(/, "must reuse sellShip(), not fly a ship to a yard itself");
  });
});

import { retireReasonKey, windDownSummary } from "../src/engine/windDownScrap.js";
test("wind-down record: the same refusal on different ships and systems is one reason, and the summary says where things stand", () => {
  const a = retireReasonKey("no known shipyard in X1-AB12 or one gate-hop away (14 waypoint(s) known there, none carry a SHIPYARD trait)");
  const b = retireReasonKey("no known shipyard in X1-QD90 or one gate-hop away (31 waypoint(s) known there, none carry a SHIPYARD trait)");
  assert.equal(a, b); assert.match(a, /^no known shipyard in <place> or one gate-hop away \(# waypoint/);
  const line = windDownSummary({ dispatched: 26, failed: 140, reasons: new Map([[a, 120], ["ship S is in transit", 20]]), queued: 150, remaining: 192, flying: 4, minutesLeft: 61.4 });
  assert.match(line, /61 min to reset: 192 non-trader hulls left, 150 queued, 4 flying to a yard, 26 sent, 140 refused/);
  assert.match(line, /120x no known shipyard/);
  assert.match(windDownSummary({ dispatched: 0, failed: 0, reasons: new Map(), queued: 0, remaining: 0, flying: 0, minutesLeft: -3 }), /0 min to reset.*top reasons: none/);
});

import { storedYardFor } from "../src/engine/windDownScrap.js";
test("a yard the fleet has seen is a yard: keepers never leave their system, and the galaxy table's waypoint traits missed it", () => {
  const yards = [{ systemSymbol: "X1-AA", waypointSymbol: "X1-AA-A2" }, { systemSymbol: "X1-BB", waypointSymbol: "X1-BB-C9" }];
  assert.equal(storedYardFor("X1-AA", yards, []), "X1-AA-A2", "its own system first");
  assert.equal(storedYardFor("X1-CC", yards, ["X1-ZZ", "X1-BB"]), "X1-BB-C9", "else one completed gate away");
  assert.equal(storedYardFor("X1-CC", yards, ["X1-ZZ"]), undefined);
  assert.equal(storedYardFor("X1-AA", [], []), undefined);
  assert.equal(storedYardFor("X1-BB", yards, ["X1-AA"]), "X1-BB-C9", "own system beats a neighbour");
});
test("traders are queued for the whole window: before, a trader that never sold out was never queued and the deadline never reached it (all 23 were left at the 2026-10-18 reset)", () => {
  const ships = [{ symbol: "K-1", role: "keeper" }, { symbol: "T-1", role: "trader" }, { symbol: "T-2", role: "trader" }];
  assert.deepEqual(shipsToRetire(ships, new Set(), 10), ["K-1"], "until then, as always");
  assert.deepEqual(shipsToRetire(ships, new Set(), 10, true), ["K-1", "T-1", "T-2"]);
  assert.deepEqual(shipsToRetire(ships, new Set(["T-1"]), 1, true), ["K-1"], "the limit and the queue still apply");
  assert.equal(shouldRetire(40, 100).retire, false, "a loaded trader waits for its own sale"); assert.equal(shouldRetire(0, 100).retire, true, "an empty one goes at once"); assert.equal(shouldRetire(40, SCRAP_DEADLINE_MIN).retire, true);
});

describe("fleet.ts wiring: the two 2026-10-18 fixes", () => {
  const src = readFileSync(new URL("../src/engine/fleet.ts", import.meta.url), "utf8");
  it("sellShip falls back to the yards the fleet has seen", () => {
    assert.match(src, /nearestShipyardForSale\(ship\.nav\.systemSymbol\) \?\? \(await this\.storedShipyardForSale\(ship\.nav\.systemSymbol\)\)/);
    assert.match(src, /storedYardFor\(systemSymbol, yards, adjacent\)/);
  });
  it("the wind-down queues traders for the whole window", () => {
    assert.match(src, /shipsToRetire\(this\.getShipStatuses\(\), this\.retireQueue, FleetManager\.RETIRE_PER_TICK, true\)/);
  });
});
