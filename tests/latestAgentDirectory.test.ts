import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

describe("Store.latestAgentDirectory (agent rank)", () => {
  const pool = createPool(DB_URL);
  const store = new Store(pool);
  before(async () => { await pool.query("DELETE FROM agent_credit_snapshots WHERE agent_symbol LIKE 'RANKTEST-%'"); });
  after(async () => { await pool.query("DELETE FROM agent_credit_snapshots WHERE agent_symbol LIKE 'RANKTEST-%'"); await pool.end(); });

  it("returns only the newest pass", async () => {
    await store.recordAgentCreditSnapshots([{ symbol: "RANKTEST-OLD", headquarters: "X1-AA1-A1", credits: 1, shipCount: 1 }]);
    await new Promise((r) => setTimeout(r, 20));
    await store.recordAgentCreditSnapshots([
      { symbol: "RANKTEST-A", headquarters: "X1-AA1-A1", credits: 900, shipCount: 2 },
      { symbol: "RANKTEST-B", headquarters: "X1-BB2-B1", credits: 100, shipCount: 3 },
    ]);
    const dir = await store.latestAgentDirectory();
    const mine = dir.agents.filter((a) => a.symbol.startsWith("RANKTEST-")).sort((a, b) => b.credits - a.credits);
    assert.deepEqual(mine, [{ symbol: "RANKTEST-A", credits: 900 }, { symbol: "RANKTEST-B", credits: 100 }]);
    assert.ok(dir.at);
  });
});
