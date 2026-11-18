import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HEALTH_POLICY as P, assessProcess, assessServerHealth, assessTenant, formatDuration, heartbeat,
  type ProcessInput, type TenantHealthInput,
} from "../src/engine/serverHealth.js";
import { gatherServerHealth } from "../src/ops/serverHealthSources.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
/** A trade every `everyMin` minutes, the last one `lastAgoMin` minutes ago, across the 3 h window. */
const trades = (everyMin: number, lastAgoMin: number) => {
  const out: number[] = [];
  for (let t = NOW - lastAgoMin * MIN; t > NOW - P.windowMs; t -= everyMin * MIN) out.push(t);
  return out;
};
const tile = (h: { tiles: { key: string }[] }, key: string) => h.tiles.find((t) => t.key === key) as any;
const traders = (n: number, idleAgoMin?: number) => Array.from({ length: n }, (_, i) => ({ symbol: `T-${i}`, ...(idleAgoMin !== undefined ? { idleSince: NOW - idleAgoMin * MIN } : {}) }));
const base = (over: Partial<TenantHealthInput> = {}): TenantHealthInput => ({
  agent: "THEO", booted: true, paused: false, tradeTimes: trades(2, 1), traders: traders(5), stuck: { crit: 0, warn: 0 },
  wallet: 3_000_000, profitLastHour: 250_000,
  loops: [{ name: "core", lastStartedAt: NOW - 1000, lastEndedAt: NOW - 900, lastMs: 100, maxMs: 800 }],
  scheduler: { queue: 120, idleSeconds: 2 }, ...over,
});
const proc = (over: Partial<ProcessInput> = {}): ProcessInput => ({
  uptimeMs: 5 * HOUR, instanceId: "box-1",
  instances: [{ instanceId: "box-1", startedAt: "", lastSeen: "", aliveNow: true }],
  api: { callsPerMin: 90, cap: 105, queueDepth: 3, oldestWaitMs: 2000, avgWaitMs: 800, maxWaitMs: 4000, hits429Last60s: 0, windowMin: 5 },
  ...over,
});

describe("serverHealth: heartbeat", () => {
  it("measures the normal gap as the median gap between trades, counting same-second lots once", () => {
    const ts = trades(4, 1).flatMap((t) => [t, t + 200]);
    const hb = heartbeat(ts, NOW);
    assert.equal(hb.normalGapMs, 4 * MIN);
    assert.equal(hb.gapMs, MIN);
    assert.equal(hb.measured, true);
  });
  it("never takes a normal gap below the floor, and assumes the default with too few trades", () => {
    assert.equal(heartbeat(trades(0.2, 0), NOW).normalGapMs, P.minNormalGapMs);
    const few = heartbeat([NOW - 5 * MIN], NOW);
    assert.equal(few.normalGapMs, P.defaultNormalGapMs);
    assert.equal(few.measured, false);
  });
  it("ignores trades outside the window", () => {
    assert.equal(heartbeat([NOW - P.windowMs - 1], NOW).gapMs, null);
  });
});

describe("serverHealth: tenant", () => {
  it("is OK / NOT STALLED on a fleet trading at its usual pace", () => {
    const h = assessTenant(base(), NOW, 5 * HOUR);
    assert.equal(h.word, "OK");
    assert.equal(tile(h, "heartbeat").word, "NOT STALLED");
    assert.equal(tile(h, "heartbeat").level, "ok");
  });
  it("says STALLED when the gap passes max(10 min, 5x normal) with traders on the books (the 2026-11-17 shape)", () => {
    const h = assessTenant(base({ tradeTimes: trades(2, 25), traders: traders(5, 20) }), NOW, 31 * HOUR);
    assert.equal(h.word, "STALLED");
    assert.equal(h.level, "bad");
    assert.equal(tile(h, "heartbeat").word, "STALLED");
    assert.equal(tile(h, "traders").word, "ALL IDLE");
    assert.equal(h.heartbeat.stalled, true);
  });
  it("scales the stall line with a slow fleet's own normal gap", () => {
    // Trades every 4 min: stall line is 20 min, so a 15 min gap is slow, not stalled.
    const h = assessTenant(base({ tradeTimes: trades(4, 15) }), NOW, 5 * HOUR);
    assert.equal(tile(h, "heartbeat").word, "SLOW");
    assert.equal(h.word, "WARN");
  });
  it("treats no trade in the whole window as stalled", () => {
    assert.equal(assessTenant(base({ tradeTimes: [] }), NOW, 5 * HOUR).word, "STALLED");
  });
  it("does not say STALLED while paused, with no traders, or just after a restart", () => {
    assert.equal(assessTenant(base({ tradeTimes: [], paused: true }), NOW, 5 * HOUR).word, "PAUSED");
    assert.equal(tile(assessTenant(base({ tradeTimes: [], traders: [] }), NOW, 5 * HOUR), "heartbeat").word, "NO TRADERS");
    const fresh = assessTenant(base({ tradeTimes: trades(2, 40) }), NOW, 3 * MIN);
    assert.equal(tile(fresh, "heartbeat").word, "STARTING");
    assert.notEqual(fresh.word, "STALLED");
  });
  it("says HUNG and STALLED when a loop has not finished a pass for 3 minutes", () => {
    const h = assessTenant(base({ loops: [{ name: "core", lastStartedAt: NOW - 4 * MIN, lastEndedAt: NOW - 4 * MIN - 500, lastMs: 100, maxMs: 4 * MIN }] }), NOW, 5 * HOUR);
    assert.equal(tile(h, "loops").word, "HUNG");
    assert.equal(h.word, "STALLED");
  });
  it("flags critical stuck ships and a dead token", () => {
    assert.equal(tile(assessTenant(base({ stuck: { crit: 1, warn: 2 } }), NOW, 5 * HOUR), "stuck").word, "CRITICAL");
    const dead = assessTenant(base({ deadToken: "token from a previous reset" }), NOW, 5 * HOUR);
    assert.equal(dead.word, "DEAD TOKEN");
  });
  it("lists a tenant with no engine here as NOT BOOTED, not as a problem", () => {
    const h = assessTenant({ agent: "OLD", booted: false }, NOW, 5 * HOUR);
    assert.equal(h.word, "NOT BOOTED");
    assert.equal(h.level, "ok");
  });
  it("gives every tile a status word, not only a level", () => {
    for (const t of assessTenant(base(), NOW, 5 * HOUR).tiles) assert.ok(t.word.length > 0, t.key);
  });
});

describe("serverHealth: process", () => {
  it("is OK at a busy but healthy rate", () => {
    const tiles = assessProcess(proc(), true);
    assert.ok(tiles.every((t) => t.level === "ok"), JSON.stringify(tiles.filter((t) => t.level !== "ok")));
  });
  it("warns when the API is nearly silent with traders on the books", () => {
    const api = assessProcess(proc({ api: { ...proc().api!, callsPerMin: 3 } }), true).find((t) => t.key === "api")!;
    assert.equal(api.word, "NEARLY SILENT");
    assert.equal(assessProcess(proc({ api: { ...proc().api!, callsPerMin: 3 } }), false).find((t) => t.key === "api")!.level, "ok");
  });
  it("grades 429s and the queue wait against the policy", () => {
    const rl = (n: number) => assessProcess(proc({ api: { ...proc().api!, hits429Last60s: n } }), true).find((t) => t.key === "ratelimit")!.level;
    assert.deepEqual([rl(0), rl(3), rl(10)], ["ok", "warn", "bad"]);
    const q = (ms: number) => assessProcess(proc({ api: { ...proc().api!, oldestWaitMs: ms } }), true).find((t) => t.key === "queue")!.word;
    assert.deepEqual([q(1000), q(45_000), q(130_000)], ["FLOWING", "BACKED UP", "BLOCKED"]);
  });
  it("warns on a deploy overlap and on uptime past 28 h", () => {
    const two = proc({ instances: [{ instanceId: "a", startedAt: "", lastSeen: "", aliveNow: true }, { instanceId: "b", startedAt: "", lastSeen: "", aliveNow: true }] });
    assert.equal(assessProcess(two, true)[0]!.word, "OVERLAP");
    assert.equal(assessProcess(proc({ uptimeMs: 29 * HOUR }), true)[0]!.word, "RESTART SOON");
  });
});

describe("serverHealth: whole board", () => {
  it("says STALLED when any tenant is stalled, with the reason first", () => {
    const r = assessServerHealth(proc(), [base(), base({ agent: "B", tradeTimes: trades(2, 30) })], NOW);
    assert.equal(r.word, "STALLED");
    assert.match(r.reasons[0]!, /^B: No buy or sell/);
  });
  it("says OK when everything is", () => {
    const r = assessServerHealth(proc(), [base()], NOW);
    assert.equal(r.word, "OK");
    assert.deepEqual(r.reasons, []);
  });
});

describe("serverHealth: sources seam", () => {
  it("gathers inputs from a worker's ledger, fleet and scheduler and assesses them", async () => {
    const ledger = trades(2, 1).map((ts) => ({ ts, type: "SELL", pnl: 1000, ship: "T-0" }));
    const w: any = {
      tenantId: "t1",
      api: { deadTokenReason: () => undefined },
      state: { get: () => ({ agent: { credits: 1234 }, ships: [] }) },
      store: { ledgerRowsSince: async () => ledger },
      scheduler: { stats_: () => ({ queue: 7, idleSeconds: 3 }) },
      fleet: {
        fleetStatusSummary: () => [{ symbol: "T-0", role: "trader", waypoint: "X", nav: "IN_ORBIT", fuel: 1, fuelCap: 1 }],
        getStrandedShips: () => [], isPaused: () => false,
        passTimings: () => [{ name: "core", lastStartedAt: Date.now() - 100, lastEndedAt: Date.now() - 50, lastMs: 50, maxMs: 200 }],
      },
    };
    const r = await gatherServerHealth({
      tenants: [{ id: "t1", agentSymbol: "THEO" }, { id: "t2", agentSymbol: "GONE" }],
      worker: (id) => (id === "t1" ? w : undefined),
      store: { opsInstances: async () => [] },
      now: NOW, uptimeMs: 5 * HOUR,
    });
    assert.deepEqual(r.notBooted, ["GONE"]);
    assert.equal(r.tenants.length, 1);
    const t = r.tenants[0]!;
    assert.equal(tile(t, "heartbeat").word, "NOT STALLED");
    assert.equal(tile(t, "wallet").value, "1,234 c");
    assert.equal(tile(t, "scheduler").value, "3 s ago");
    assert.deepEqual(r.errors, []);
  });
});

describe("serverHealth: formatDuration", () => {
  it("reads in seconds, minutes, then hours", () => {
    assert.equal(formatDuration(180), "0.2 s");
    assert.equal(formatDuration(0), "0 s");
    assert.equal(formatDuration(45_000), "45 s");
    assert.equal(formatDuration(12 * MIN), "12 min");
    assert.equal(formatDuration(3 * HOUR + 5 * MIN), "3 h 05 min");
  });
});
