import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryStats, queryLabel } from "../src/db/queryStats.js";
import { summarize } from "../src/engine/taskTiming.js";

describe("queryStats (issue #88 P0)", () => {
  it("folds literals and parameters so one statement is one row, and skips transaction control", () => {
    assert.equal(queryLabel("SELECT *  FROM market_latest\n WHERE waypoint_symbol = $1 AND units > 20"), "SELECT * FROM market_latest WHERE waypoint_symbol = ? AND units > ?");
    assert.equal(queryLabel({ text: "UPDATE ship_state SET x = 'abc' WHERE id = 7" }), "UPDATE ship_state SET x = ? WHERE id = ?");
    assert.equal(queryLabel("BEGIN"), undefined);
    assert.equal(queryLabel("SET LOCAL app.tenant_id = 'x'"), undefined);
  });
  it("sums time per shape, sorted by total, in the window only", () => {
    const q = new QueryStats();
    const M = 60_000;
    q.record({ at: 1 * M, label: "A", ms: 10, rows: 1 });
    q.record({ at: 2 * M, label: "A", ms: 30, rows: 3 });
    q.record({ at: 3 * M, label: "B", ms: 100, rows: 500 });
    q.record({ at: 20 * M, label: "C", ms: 1, rows: 0 });
    const r = q.summary(21 * M, 30 * M);
    assert.deepEqual(r.queries.map((x) => x.label), ["B", "A", "C"]);
    assert.equal(r.queries[1]!.avgMs, 20);
    assert.equal(r.queries[0]!.avgRows, 500);
    assert.equal(q.summary(21 * M, 5 * M).calls, 1);
  });
});

describe("taskTiming: queue delay (issue #88 P0)", () => {
  it("reports how long tasks waited after coming due", () => {
    const s = summarize("trade", [
      { at: 1, kind: "trade", totalMs: 100, steps: {}, counts: {}, queueMs: 0 },
      { at: 2, kind: "trade", totalMs: 100, steps: {}, counts: {}, queueMs: 4000 },
      { at: 3, kind: "trade", totalMs: 100, steps: {}, counts: {}, queueMs: 2000 },
    ], 600_000);
    assert.equal(s.avgQueueMs, 2000);
    assert.equal(s.maxQueueMs, 4000);
  });
});
