import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkpoints, hoursReached, likeForLike, toPoints, weekTotals, type HourRow } from "../src/engine/weekCompare.js";

const row = (hour: number, o: Partial<HourRow> = {}): HourRow => ({ hour, sells: 0, pnl: 0, revenue: 0, purchases: 0, ships: 0, jumps: 0, wallet: null, ...o });

describe("weekCompare: two weeks lined up by hours since the first trade", () => {
  const a = { hours: [row(0, { pnl: 100, sells: 2, wallet: 1000 }), row(2, { pnl: 300, sells: 3, ships: 1 }), row(3, { pnl: 50, wallet: 900 })] };

  it("one point per hour, profit cumulative, wallet carried over hours with no reading, empty hours kept", () => {
    const p = toPoints(a, 4);
    assert.deepEqual(p.map((x) => x.cumPnl), [100, 100, 400, 450, 450]);
    assert.deepEqual(p.map((x) => x.wallet), [1000, 1000, 1000, 900, 900], "hour 2 had no wallet reading: the last one stands");
    assert.deepEqual(p.map((x) => x.pnl), [100, 0, 300, 50, 0]);
    assert.equal(p[3]!.ships, 1);
    assert.equal(p[3]!.trades, 5);
  });

  it("totals: profit, per-hour rate over the hours the ledger reaches, best hour, last wallet", () => {
    const t = weekTotals(a);
    assert.equal(t.hoursReached, 3);
    assert.equal(t.matchedPnl, 450);
    assert.equal(t.pnlPerHour, 150);
    assert.equal(t.bestHourPnl, 300);
    assert.equal(t.endWallet, 900);
  });

  it("checkpoints: a week that had not reached an hour has nothing there, and no delta", () => {
    const b = { hours: [row(0, { pnl: 10 }), row(10, { pnl: 1_000 })] };
    const rows = checkpoints(toPoints(a, 12), toPoints(b, 12), hoursReached(a), hoursReached(b), [2, 10]);
    assert.equal(rows[0]!.pnlDelta, 400 - 10, "both weeks reached hour 2");
    assert.equal(rows[1]!.a, null, "the first week stops at hour 3");
    assert.equal(rows[1]!.pnlDelta, null);
  });

  it("like for like cuts both weeks at the shorter one's last hour, so a week in progress is not set against a finished one", () => {
    const finished = { hours: [row(0, { pnl: 100 }), row(5, { pnl: 900 }), row(40, { pnl: 5_000 })] };
    const inProgress = { hours: [row(0, { pnl: 50 }), row(5, { pnl: 150 })] };
    const l = likeForLike(inProgress, finished);
    assert.equal(l.hours, 5);
    assert.equal(l.a.matchedPnl, 200);
    assert.equal(l.b.matchedPnl, 1_000, "the finished week's hour-40 profit is outside the window");
  });

  it("an empty week reaches hour 0 and totals nothing", () => {
    assert.equal(hoursReached({ hours: [] }), 0);
    assert.equal(weekTotals({ hours: [] }).matchedPnl, 0);
  });
});
