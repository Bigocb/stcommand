import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { AgentWatcher } from "../src/engine/agentWatcher.js";
import { createPool } from "../src/db/pool.js";
import { Store } from "../src/db/store.js";
import { OPS_BY_NAME } from "../src/ops/catalog.js";

/** The watcher against a fake public API and the real database: sightings, brackets, samples, gate timelines, backfill, resets, failure. */

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://stcommand:stcommand_dev@localhost:5432/stcommand";
const RESET = "2099-01-03";
const RESET2 = "2099-01-10";
const MIN = 60_000;
const T0 = Date.parse("2099-01-03T14:00:00Z");
let pool: pg.Pool;
let store: Store;

before(async () => { pool = createPool(DB_URL); store = new Store(pool); await clean(); });
after(async () => { await clean(); await pool.end(); });

async function clean() {
  for (const t of ["agent_sightings", "agent_samples", "gate_progress_samples"]) await pool.query(`DELETE FROM ${t} WHERE reset_date = ANY($1)`, [[RESET, RESET2]]);
  await pool.query(`DELETE FROM agent_credit_snapshots WHERE agent_symbol LIKE 'WATCHTEST%'`);
}

type Agent = { symbol: string; headquarters: string; credits: number; startingFaction: string; shipCount: number };
const ag = (symbol: string, hq: string, over: Partial<Agent> = {}): Agent => ({ symbol, headquarters: hq, credits: 175000, startingFaction: "COSMIC", shipCount: 2, ...over });

/** A fake of the public API. `gates` maps gate symbol to [fulfilled, required, complete]. */
function fakeApi() {
  const state = { reset: RESET, agents: [] as Agent[], gates: new Map<string, [number, number, boolean]>(), failAgents: false, urls: [] as string[] };
  const fetchFn = (async (input: URL | string) => {
    const url = String(input);
    state.urls.push(url);
    const path = url.replace("https://api.spacetraders.io/v2", "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/" || path === "") return json({ resetDate: state.reset });
    if (path.startsWith("/agents")) {
      if (state.failAgents) return json({}, 500);
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return json({ data: state.agents.slice((page - 1) * 20, page * 20), meta: { total: state.agents.length } });
    }
    const gate = /\/waypoints\/([^/?]+)\/construction$/.exec(path)?.[1];
    if (gate) {
      const g = state.gates.get(gate);
      if (!g) return json({}, 404);
      return json({ data: { symbol: gate, isComplete: g[2], materials: [{ tradeSymbol: "FAB_MATS", required: g[1], fulfilled: g[0] }] } });
    }
    const sys = /\/systems\/([^/]+)\/waypoints\?type=JUMP_GATE/.exec(path)?.[1];
    if (sys) return json({ data: [{ symbol: `${sys}-I1` }] });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

function watcher(api: ReturnType<typeof fakeApi>, clock: { t: number }) {
  return new AgentWatcher(store, () => {}, { fetchFn: api.fetchFn, now: () => clock.t, sleep: async () => {}, scanIntervalMs: 15 * MIN, sampleIntervalMs: 30 * MIN });
}

describe("AgentWatcher", () => {
  it("records a baseline on the first scan, brackets new agents on the next, samples gates only when they change, and stops reading a finished gate", async () => {
    await clean();
    const api = fakeApi();
    const clock = { t: T0 };
    api.state.agents = [ag("WATCHTEST-A", "X1-AAA-A1"), ag("WATCHTEST-B", "X1-AAA-A1")];
    api.state.gates.set("X1-AAA-I1", [1, 2001, false]);
    const w = watcher(api, clock);

    await w.tick();
    let rows = await store.loadAgentSightings(RESET);
    assert.deepEqual(rows.map((r) => [r.agent, r.source]), [["WATCHTEST-A", "baseline"], ["WATCHTEST-B", "baseline"]]);
    let samples = await store.latestGateSamples(RESET);
    assert.deepEqual([samples.get("X1-AAA-I1")?.fulfilled, samples.get("X1-AAA-I1")?.complete], [1, false]);

    // Too soon: nothing happens.
    clock.t = T0 + 5 * MIN;
    const before = api.state.urls.length;
    await w.tick();
    assert.equal(api.state.urls.length, before, "no request before the scan interval");

    // 15 minutes later: one new agent in a new system, one in the old; the old gate has moved.
    clock.t = T0 + 15 * MIN;
    api.state.agents.push(ag("WATCHTEST-C", "X1-AAA-A1", { credits: 175000 }), ag("WATCHTEST-D", "X1-BBB-A1", { startingFaction: "AEGIS" }));
    api.state.agents[0] = ag("WATCHTEST-A", "X1-AAA-A1", { credits: 900000, shipCount: 5 });
    api.state.gates.set("X1-AAA-I1", [400, 2001, false]);
    api.state.gates.set("X1-BBB-I1", [1, 2001, false]);
    await w.tick();
    rows = await store.loadAgentSightings(RESET);
    const c = rows.find((r) => r.agent === "WATCHTEST-C")!;
    const d = rows.find((r) => r.agent === "WATCHTEST-D")!;
    assert.deepEqual([c.source, c.priorScanAt, c.firstSeenAt, c.agentsInSystem, c.faction], ["live", T0, T0 + 15 * MIN, 3, "COSMIC"]);
    assert.deepEqual([d.source, d.agentsInSystem, d.faction], ["live", 1, "AEGIS"]);
    assert.deepEqual([rows.find((r) => r.agent === "WATCHTEST-A")!.lastCredits, rows.find((r) => r.agent === "WATCHTEST-A")!.lastShips], [900000, 5], "an agent already known is refreshed");
    assert.equal(rows.find((r) => r.agent === "WATCHTEST-A")!.source, "baseline", "and keeps its original source");
    samples = await store.latestGateSamples(RESET);
    assert.equal(samples.get("X1-AAA-I1")!.fulfilled, 400, "a new agent's system is read at once");
    assert.equal(samples.get("X1-BBB-I1")!.fulfilled, 1, "and the new system's gate is on record at first sight");

    // The gate finishes; after that it is never read again.
    clock.t = T0 + 60 * MIN;
    api.state.gates.set("X1-AAA-I1", [2001, 2001, true]);
    await w.tick();
    clock.t = T0 + 120 * MIN;
    api.state.urls.length = 0;
    await w.tick();
    assert.ok(!api.state.urls.some((u) => u.includes("X1-AAA-I1")), "a finished gate is final");
    const timeline = await store.gateSamplesForSystems(RESET, ["X1-AAA"]);
    assert.deepEqual(timeline.map((s) => [s.fulfilled, s.complete]), [[1, false], [400, false], [2001, true]], "rows only where something changed");
  });

  it("writes nothing from a scan that cannot read the whole agent list, and carries on at the next interval", async () => {
    await clean();
    const api = fakeApi();
    const clock = { t: T0 };
    api.state.agents = [ag("WATCHTEST-A", "X1-AAA-A1")];
    api.state.failAgents = true;
    const w = watcher(api, clock);
    await w.tick(); // must not throw
    assert.equal((await store.loadAgentSightings(RESET)).length, 0);
    api.state.failAgents = false;
    clock.t = T0 + 1 * MIN;
    await w.tick();
    assert.equal((await store.loadAgentSightings(RESET)).length, 1, "tried again at once because the failed scan did not count");
  });

  it("copies the reset's hourly snapshots in before they are wiped, and brackets later arrivals from them", async () => {
    await clean();
    await pool.query(
      `INSERT INTO agent_credit_snapshots (system_symbol, agent_symbol, credits, ship_count, timestamp) VALUES
        ('X1-AAA', 'WATCHTEST-A', 175000, 2, $1), ('X1-AAA', 'WATCHTEST-A', 500000, 7, $2), ('X1-BBB', 'WATCHTEST-B', 175000, 2, $2)`,
      [new Date(T0 - 5 * 3_600_000).toISOString(), new Date(T0 - 1 * 3_600_000).toISOString()],
    );
    const api = fakeApi();
    api.state.agents = [ag("WATCHTEST-A", "X1-AAA-A1", { credits: 600000, shipCount: 8 }), ag("WATCHTEST-B", "X1-BBB-A1"), ag("WATCHTEST-NEW", "X1-CCC-A1")];
    await watcher(api, { t: T0 }).tick();
    const rows = await store.loadAgentSightings(RESET);
    const a = rows.find((r) => r.agent === "WATCHTEST-A")!;
    assert.deepEqual([a.source, a.firstSeenAt, a.firstCredits, a.lastCredits], ["snapshot", T0 - 5 * 3_600_000, 175000, 600000], "first seen is the first hourly snapshot; now comes from the live scan");
    assert.equal(a.faction, "COSMIC", "the faction a snapshot lacks is filled in by the live scan");
    const n = rows.find((r) => r.agent === "WATCHTEST-NEW")!;
    assert.deepEqual([n.source, n.priorScanAt], ["live", T0 - 1 * 3_600_000], "bracketed from the newest snapshot, since this process had no earlier scan");
    const { rows: samp } = await pool.query(`SELECT count(*)::int AS n FROM agent_samples WHERE reset_date = $1 AND agent_symbol = 'WATCHTEST-A'`, [RESET]);
    assert.ok(samp[0].n >= 3, "snapshots became samples, plus this scan's");
  });

  it("starts a fresh record when the reset date changes", async () => {
    await clean();
    const api = fakeApi();
    const clock = { t: T0 };
    api.state.agents = [ag("WATCHTEST-A", "X1-AAA-A1")];
    const w = watcher(api, clock);
    await w.tick();
    api.state.reset = RESET2;
    api.state.agents = [ag("WATCHTEST-X", "X1-ZZZ-A1")];
    clock.t = T0 + 20 * MIN;
    await w.tick();
    assert.deepEqual((await store.loadAgentSightings(RESET2)).map((r) => [r.agent, r.source]), [["WATCHTEST-X", "baseline"]]);
    assert.equal((await store.loadAgentSightings(RESET)).length, 1, "last week is kept");
    assert.deepEqual((await store.agentWatchResets()).filter((r) => r.startsWith("2099")), [RESET2, RESET]);
  });
});

describe("ops agent_watch", () => {
  it("answers 'when did the siblings register and what did the start gate look like'", async () => {
    await clean();
    const api = fakeApi();
    const clock = { t: T0 };
    api.state.agents = [ag("WATCHTEST-FIRST", "X1-AAA-A1")];
    api.state.gates.set("X1-AAA-I1", [1, 2001, false]);
    const w = watcher(api, clock);
    await w.tick();
    clock.t = T0 + 15 * MIN;
    api.state.agents.push(ag("WATCHTEST-FIRST496", "X1-AAA-A1", { credits: 175000 }));
    api.state.gates.set("X1-AAA-I1", [2001, 2001, true]);
    await w.tick();
    const tool = OPS_BY_NAME.get("agent_watch")!;
    const out: any = await tool.run({ w: { store } as any, now: () => T0 + 30 * MIN }, { agent: "watchtest-first", resetDate: RESET, limit: 10 });
    assert.equal(out.matched, 2);
    const late = out.rows.find((r: any) => r.agent === "WATCHTEST-FIRST496");
    assert.equal(late.source, "live");
    assert.equal(late.registeredAfter, new Date(T0).toISOString());
    assert.deepEqual([late.gateAtFirstSeen.complete, late.gateAtFirstSeen.fulfilled], [true, 2001], "the gate it saw when it appeared");
    const early = out.rows.find((r: any) => r.agent === "WATCHTEST-FIRST");
    assert.deepEqual([early.source, early.gateAtFirstSeen.complete], ["baseline", false]);
    assert.equal(out.gateBuilds.systemsWithATimeline, 1);
    assert.equal(out.gateBuilds.medianHours, 0.3, "15 minutes of observed building: 0.25h rounds to 0.3");
    const none: any = await tool.run({ w: { store } as any, now: () => T0 }, { resetDate: "2098-01-01", limit: 5 });
    assert.equal(none.agents, 0);
  });
});
