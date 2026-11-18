import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { assessServerHealth, healthHistory, healthSampleRows, type ProcessInput, type TenantHealthInput } from "../src/engine/serverHealth.js";

/** The health board's history through the real table (migration 068): write a reading, read it back, prune. */
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
let pool: pg.Pool;
let store: Store;
const SCOPE = `HSTEST-${process.pid}`;
const MIN = 60_000;

const proc: ProcessInput = {
  uptimeMs: 31 * 3_600_000, instanceId: "i", instances: [],
  api: { callsPerMin: 3.5, cap: 105, queueDepth: 0, oldestWaitMs: 0, avgWaitMs: 0, maxWaitMs: 0, hits429Last60s: 0, windowMin: 5 },
};
const tenant = (now: number): TenantHealthInput => ({
  agent: SCOPE, booted: true, paused: false, tradeTimes: [now - 64 * MIN, now - 66 * MIN, now - 68 * MIN, now - 70 * MIN],
  traders: [{ symbol: "A", idleSince: now - 55 * MIN }], stuck: { crit: 0, warn: 0 }, wallet: 4_812_330, profitLastHour: 0,
  loops: [{ name: "core", lastStartedAt: now - 1000, lastEndedAt: now - 900, lastMs: 100, maxMs: 800 }], scheduler: null,
});

before(async () => {
  pool = createPool(DB_URL);
  store = new Store(pool);
  await pool.query(`DELETE FROM health_samples WHERE scope = $1 OR instance_id = $2`, [SCOPE, `test-${process.pid}`]);
});
after(async () => {
  await pool.query(`DELETE FROM health_samples WHERE scope = $1 OR instance_id = $2`, [SCOPE, `test-${process.pid}`]);
  await pool.end();
});

describe("Store: health samples", () => {
  it("writes a reading and reads it back as the board's history, then prunes old rows", async () => {
    const now = Math.floor(Date.now() / 1000) * 1000; // the heartbeat counts trades to the second
    const old = now - 8 * 24 * 3_600_000;
    for (const t of [old, now - MIN, now]) await store.recordHealthSamples(`test-${process.pid}`, healthSampleRows(assessServerHealth(proc, [tenant(t)], t), t));
    // The same reading twice (an overlap or a retry) is ignored, not an error.
    await store.recordHealthSamples(`test-${process.pid}`, healthSampleRows(assessServerHealth(proc, [tenant(now)], now), now));

    const rows = (await store.listHealthSamples(new Date(now - 6 * 3_600_000).toISOString())).filter((r) => r.scope === SCOPE);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.word, "STALLED");
    assert.equal(rows[1]!.gapMs, 64 * MIN);
    assert.equal(rows[1]!.stallLineMs, 10 * MIN);
    assert.equal(rows[1]!.wallet, 4_812_330);
    assert.equal(rows[1]!.callsPerMin, null);
    const h = healthHistory(rows, now, 6);
    assert.equal(h.tenants[0]!.agent, SCOPE);
    assert.deepEqual(h.minutes[SCOPE], { ok: 0, warn: 0, bad: 2 });

    const server = (await store.listHealthSamples(new Date(now - 2 * MIN).toISOString())).filter((r) => r.scope === "server" && r.sampledAt === new Date(now).toISOString());
    assert.equal(server[0]!.callsPerMin, 3.5);
    assert.equal(server[0]!.cap, 105);

    assert.ok((await store.pruneHealthSamples(new Date(now - 7 * 24 * 3_600_000).toISOString())) >= 2);
    const left = (await store.listHealthSamples(new Date(old - MIN).toISOString())).filter((r) => r.scope === SCOPE);
    assert.equal(left.length, 2, "only the 8-day-old reading was pruned");
  });
});
