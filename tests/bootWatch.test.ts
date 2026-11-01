import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BootWatch } from "../src/engine/bootWatch.js";

const B = Date.UTC(2026, 10, 1, 12, 0, 0);
const at = (sec: number) => B + sec * 1000;

describe("BootWatch", () => {
  it("compares the first cycle with the saved trips", () => {
    const w = new BootWatch(B);
    w.noteRestored([{ ship: "A", key: "IRON|X-1>X-2" }, { ship: "B", key: "GOLD|X-3>X-4" }, { ship: "C", key: "FOOD|X-5>X-6" }, { ship: "D", key: null }]);
    w.observe(at(20), [
      { ship: "A", key: "IRON|X-1>X-2", loaded: true },
      { ship: "B", key: "GOLD|X-9>X-4", loaded: true },
      { ship: "C", key: null, loaded: false },
      { ship: "D", key: "OIL|X-7>X-8", loaded: false },
    ]);
    const s = w.summary(at(30));
    assert.equal(s.restoredTrips, 3);
    assert.deepEqual(s.firstCycle, { traders: 4, withRoute: 3, kept: 1, changed: 1, dropped: 1, fresh: 1, loadedAndChanged: 1 });
    assert.equal(s.changes.length, 3);
    assert.equal(s.changes.find((c) => c.ship === "B")?.change, "changed");
  });

  it("tracks churn on later cycles and ignores restored data after the first call", () => {
    const w = new BootWatch(B);
    w.noteRestored([{ ship: "A", key: "X" }]);
    w.noteRestored([{ ship: "A", key: "Y" }]);
    w.observe(at(10), [{ ship: "A", key: "X", loaded: false }]);
    w.observe(at(70), [{ ship: "A", key: "Z", loaded: true }]);
    const s = w.summary(at(80));
    assert.equal(s.firstCycle?.kept, 1);
    assert.deepEqual(s.churn, [{ cycle: 1, changed: 1, loadedChanged: 1 }]);
  });

  it("counts actions per minute and the time to each ship's first trade", () => {
    const w = new BootWatch(B);
    w.observe(at(5), [{ ship: "A", key: null, loaded: false }, { ship: "B", key: null, loaded: false }]);
    w.noteAction(at(30), "A", "buy");
    w.noteAction(at(40), "A", "sell");
    w.noteAction(at(70), "B", "jump");
    w.noteAction(at(130), "B", "sell");
    const s = w.summary(at(140));
    assert.deepEqual(s.perMinute, [{ minute: 0, buy: 1, sell: 1, jump: 0, other: 0 }, { minute: 1, buy: 0, sell: 0, jump: 1, other: 0 }, { minute: 2, buy: 0, sell: 1, jump: 0, other: 0 }]);
    assert.equal(s.tradedInWindow, 2);
    assert.equal(s.neverTraded, 0);
    assert.deepEqual(s.firstTradeSec, { median: 130, slowest: 130 });
  });

  it("stops recording after the window and reports when it is due to save", () => {
    const w = new BootWatch(B, 60_000);
    w.observe(at(10), [{ ship: "A", key: null, loaded: false }]);
    assert.equal(w.due(at(30)), false);
    w.noteAction(at(90), "A", "buy");
    w.observe(at(100), [{ ship: "A", key: "X", loaded: false }]);
    assert.equal(w.summary(at(100)).cycles, 1);
    assert.equal(w.summary(at(100)).actionsByKind.buy, undefined);
    assert.equal(w.due(at(100)), true);
    w.markPersisted();
    assert.equal(w.due(at(200)), false);
  });
});
