import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseCgroupMemory, classifyEnd, processHistory, type ProcessBeat } from "../src/ops/containerStats.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";

describe("parseCgroupMemory", () => {
  it("v2: limit, current, peak, OOM counters and anon/file", () => {
    const m = parseCgroupMemory({ v2: { max: "4294967296\n", current: "3000000000\n", peak: "4200000000\n", events: "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\n", stat: "anon 2500000000\nfile 400000000\n" } });
    assert.equal(m.version, "v2");
    assert.equal(m.limitBytes, 4294967296);
    assert.equal(m.currentBytes, 3000000000);
    assert.equal(m.peakBytes, 4200000000);
    assert.equal(m.oomKills, 2);
    assert.equal(m.oomEvents, 3);
    assert.equal(m.anonBytes, 2500000000);
  });
  it("v2 with no limit says null, not a number", () => {
    assert.equal(parseCgroupMemory({ v2: { max: "max\n", current: "10\n" } }).limitBytes, null);
  });
  it("v1: the huge 'unlimited' value is no limit; oom_kill comes from memory.oom_control", () => {
    const m = parseCgroupMemory({ v1: { limit: "9223372036854771712\n", usage: "100\n", maxUsage: "200\n", oomControl: "oom_kill_disable 0\nunder_oom 0\noom_kill 1\n", stat: "total_rss 50\ntotal_cache 30\n" } });
    assert.equal(m.version, "v1");
    assert.equal(m.limitBytes, null);
    assert.equal(m.peakBytes, 200);
    assert.equal(m.oomKills, 1);
    assert.equal(m.anonBytes, 50);
  });
  it("nothing readable gives version none", () => {
    assert.equal(parseCgroupMemory({}).version, "none");
  });
});

const beat = (o: Partial<ProcessBeat>): ProcessBeat => ({ instanceId: "a", startedAt: "2026-11-21T16:35:00Z", lastSeen: "2026-11-21T20:40:30Z", aliveNow: false, ...o });

describe("classifyEnd", () => {
  it("still beating is running", () => {
    assert.equal(classifyEnd(beat({ aliveNow: true }), undefined).kind, "running");
  });
  it("the next process on newer code means a deploy, with the gap between them", () => {
    const e = classifyEnd(beat({ codeMtime: "2026-11-21T16:35:13Z", heapUsedMb: 4000, heapLimitMb: 4144 }), beat({ instanceId: "b", startedAt: "2026-11-21T20:40:50Z", codeMtime: "2026-11-21T20:40:00Z", build: "abc1234" }));
    assert.equal(e.kind, "deploy", "a deploy wins even with a full heap");
    assert.equal(e.gapSec, 20);
  });
  it("same code and the heap within 10% of the limit: heap OOM likely", () => {
    const e = classifyEnd(beat({ codeMtime: "2026-11-21T16:35:13Z", heapUsedMb: 3900, heapLimitMb: 4144, rssMb: 4500 }), beat({ instanceId: "b", startedAt: "2026-11-21T20:40:52Z", codeMtime: "2026-11-21T16:35:13Z" }));
    assert.equal(e.kind, "heap_oom_likely");
  });
  it("resident memory near the container limit, or a rising OOM-kill counter: container OOM likely", () => {
    assert.equal(classifyEnd(beat({ rssMb: 7400, cgroupLimitMb: 8000, heapUsedMb: 2000, heapLimitMb: 4144 }), beat({ instanceId: "b", startedAt: "2026-11-21T20:41:00Z" })).kind, "container_oom_likely");
    assert.equal(classifyEnd(beat({ oomKills: 0, heapUsedMb: 1, heapLimitMb: 4144 }), beat({ instanceId: "b", startedAt: "2026-11-21T20:41:00Z", oomKills: 1 })).kind, "container_oom_likely");
  });
  it("same code and memory well under every limit: unknown, and it says so", () => {
    const e = classifyEnd(beat({ heapUsedMb: 1000, heapLimitMb: 4144, rssMb: 1500 }), beat({ instanceId: "b", startedAt: "2026-11-21T20:41:00Z" }));
    assert.equal(e.kind, "unknown");
    assert.match(e.reason, /heap 1000\/4144/);
  });
});

describe("processHistory", () => {
  it("orders by start and classifies each against the one after it", () => {
    const h = processHistory([beat({ instanceId: "b", startedAt: "2026-11-21T20:40:52Z", aliveNow: true }), beat({ instanceId: "a" })]);
    assert.deepEqual(h.map((x) => [x.instanceId, x.end.kind]), [["a", "unknown"], ["b", "running"]]);
  });
});

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";

describe("Store heartbeat memory (migration 070)", () => {
  const pool = createPool(DB_URL);
  const store = new Store(pool);
  const id = `test-container-${Date.now()}`;
  after(async () => { await pool.query("DELETE FROM instance_heartbeats WHERE instance_id = $1", [id]); await pool.end(); });
  before(async () => { await pool.query("DELETE FROM instance_heartbeats WHERE instance_id = $1", [id]); });

  it("keeps the last beat's memory, and a beat without figures does not erase them", async () => {
    const started = new Date();
    await store.touchInstance(id, started, { rssMb: 3700, heapUsedMb: 2000, heapLimitMb: 4144, cgroupCurrentMb: 3800, cgroupLimitMb: null, oomKills: 0, build: "abc1234", codeMtime: "2026-11-21T21:15:12.000Z" });
    await store.touchInstance(id, started);
    const row = (await store.instanceHistory(1)).find((r) => r.instanceId === id)!;
    assert.equal(row.heapUsedMb, 2000);
    assert.equal(row.cgroupLimitMb, null);
    assert.equal(row.build, "abc1234");
    assert.equal(row.codeMtime, "2026-11-21T21:15:12.000Z");
    assert.equal(row.aliveNow, true);
  });
});
