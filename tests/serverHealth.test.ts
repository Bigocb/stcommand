import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HEALTH_POLICY as P, EMPTY_ALERT_STATE, assessProcess, assessServerHealth, assessTenant, decideStallAlert, formatDuration, healthHistory,
  healthSampleRows, heartbeat, type ProcessInput, type StallAlertState, type TenantHealthInput,
} from "../src/engine/serverHealth.js";
import { gatherServerHealth } from "../src/ops/serverHealthSources.js";
import { HealthRecorder } from "../src/engine/healthRecorder.js";
import { stallAlerts } from "../src/engine/stallAlerts.js";
import { healthDetector } from "../src/engine/notify/detectors.js";

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

// ── Phase 2: history rows, the stall alert, the recorder ──────────────────

/** The 2026-11-17 stall: 64 min with no trade at ~31 h uptime, all 14 traders idle. */
const loopsAt = (now: number) => [{ name: "core", lastStartedAt: now - 1000, lastEndedAt: now - 900, lastMs: 100, maxMs: 800 }];
const nov17 = (now = NOW) => assessTenant(base({ tradeTimes: trades(2, 64).map((t) => t - (NOW - now)), traders: traders(14, 55), loops: loopsAt(now) }), now, 31 * HOUR);
const healthy = (now = NOW) => assessTenant(base({ tradeTimes: trades(2, 1).map((t) => t - (NOW - now)), loops: loopsAt(now) }), now, 31 * HOUR);
const COOL = 15 * MIN;

describe("serverHealth: stall alert decision", () => {
  it("alerts on the 2026-11-17 stall, with a message that names the gap and no credit figures", () => {
    const d = decideStallAlert(EMPTY_ALERT_STATE, nov17(), NOW, COOL);
    assert.equal(d.alert, true);
    assert.equal(d.title, "THEO: engine STALLED");
    assert.match(d.body!, /No buy or sell for 64 min/);
    assert.doesNotMatch(d.body!, /\d,\d{3}/);
  });
  it("does not alert while healthy", () => {
    assert.equal(decideStallAlert(EMPTY_ALERT_STATE, healthy(), NOW, COOL).alert, false);
  });
  it("alerts once per stall, however long it lasts", () => {
    let s: StallAlertState = EMPTY_ALERT_STATE;
    const alerts: number[] = [];
    for (let m = 0; m <= 120; m++) {
      const d = decideStallAlert(s, nov17(NOW + m * MIN), NOW + m * MIN, COOL);
      s = d.state;
      if (d.alert) alerts.push(m);
    }
    assert.deepEqual(alerts, [0]);
  });
  it("a stall that clears and returns inside the cool-down is held until the cool-down ends", () => {
    let s = decideStallAlert(EMPTY_ALERT_STATE, nov17(), NOW, COOL).state;
    s = decideStallAlert(s, healthy(NOW + 3 * MIN), NOW + 3 * MIN, COOL).state;
    const again = decideStallAlert(s, nov17(NOW + 6 * MIN), NOW + 6 * MIN, COOL);
    assert.equal(again.alert, false);
    assert.match(again.reason, /cool-down/);
    const later = decideStallAlert(again.state, nov17(NOW + 15 * MIN), NOW + 15 * MIN, COOL);
    assert.equal(later.alert, true, "still stalled when the cool-down ends: announced then");
  });
  it("a new stall after the cool-down is announced", () => {
    let s = decideStallAlert(EMPTY_ALERT_STATE, nov17(), NOW, COOL).state;
    s = decideStallAlert(s, healthy(NOW + 20 * MIN), NOW + 20 * MIN, COOL).state;
    assert.equal(decideStallAlert(s, nov17(NOW + 40 * MIN), NOW + 40 * MIN, COOL).alert, true);
  });
  it("alerts on a hung engine loop and says so", () => {
    const hung = assessTenant(base({ loops: [{ name: "core", lastStartedAt: NOW - 4 * MIN, lastEndedAt: NOW - 4 * MIN, lastMs: 100, maxMs: 4 * MIN }] }), NOW, 5 * HOUR);
    const d = decideStallAlert(EMPTY_ALERT_STATE, hung, NOW, COOL);
    assert.equal(d.alert, true);
    assert.equal(d.title, "THEO: engine HUNG");
  });
  it("never alerts while paused or just after a restart", () => {
    assert.equal(decideStallAlert(EMPTY_ALERT_STATE, assessTenant(base({ tradeTimes: [], paused: true }), NOW, 5 * HOUR), NOW, COOL).alert, false);
    assert.equal(decideStallAlert(EMPTY_ALERT_STATE, assessTenant(base({ tradeTimes: trades(2, 40) }), NOW, 3 * MIN), NOW, COOL).alert, false);
  });
});

describe("serverHealth: history rows", () => {
  it("stores a server row and one row per running tenant, with the stall line", () => {
    const r = assessServerHealth(proc({ api: { ...proc().api!, callsPerMin: 3 } }), [base({ tradeTimes: trades(2, 64), traders: traders(14, 55) }), { agent: "OLD", booted: false }], NOW);
    const rows = healthSampleRows(r, NOW);
    assert.deepEqual(rows.map((x) => x.scope), ["server", "THEO"]);
    assert.equal(rows[0]!.word, "STALLED");
    assert.equal(rows[0]!.callsPerMin, 3);
    assert.equal(rows[0]!.cap, 105);
    assert.equal(rows[0]!.gapMs, null);
    assert.equal(rows[1]!.gapMs, 64 * MIN);
    assert.equal(rows[1]!.stallLineMs, 10 * MIN);
    assert.equal(rows[1]!.idleTraders, 14);
    assert.equal(rows[1]!.callsPerMin, null);
  });
  it("groups readings by scope, oldest first, and counts minutes by level", () => {
    const r1 = healthSampleRows(assessServerHealth(proc(), [base()], NOW - MIN), NOW - MIN);
    const r2 = healthSampleRows(assessServerHealth(proc(), [base({ tradeTimes: [] })], NOW), NOW);
    const h = healthHistory([...r2, ...r1], NOW, 6);
    assert.equal(h.server.length, 2);
    assert.equal(h.tenants[0]!.agent, "THEO");
    assert.ok(h.tenants[0]!.rows[0]!.sampledAt < h.tenants[0]!.rows[1]!.sampledAt);
    assert.deepEqual(h.minutes.THEO, { ok: 1, warn: 0, bad: 1 });
  });
});

describe("health recorder", () => {
  const fakeStore = () => {
    const stored: unknown[][] = [];
    return { stored, recordHealthSamples: async (_id: string, rows: unknown[]) => { stored.push(rows); }, pruneHealthSamples: async () => 0 };
  };
  it("stores each reading and raises the alert once, on the stall, when the clause is on", async () => {
    const store = fakeStore();
    const logs: string[] = [];
    let stalled = true;
    const rec = new HealthRecorder({
      read: async (now) => assessServerHealth(proc(), [base({ tradeTimes: trades(2, stalled ? 64 : 1).map((t) => t - (NOW - now)), loops: loopsAt(now) })], now),
      store, alertSettings: () => ({ tenantId: "t-rec", enabled: true, cooldownMs: COOL }), instanceId: "i1", log: (m) => logs.push(m),
    });
    assert.deepEqual((await rec.tick(NOW)).alerts, ["THEO"]);
    assert.equal(stallAlerts.get("t-rec")?.title, "THEO: engine STALLED");
    assert.deepEqual((await rec.tick(NOW + MIN)).alerts, []);
    assert.equal(logs.filter((l) => l.startsWith("HEALTH ALERT")).length, 1);
    stalled = false;
    await rec.tick(NOW + 2 * MIN);
    assert.equal(stallAlerts.has("t-rec"), false, "cleared when the stall ends");
    assert.equal(store.stored.length, 3);
  });
  it("logs but does not push when the clause is off", async () => {
    const logs: string[] = [];
    const rec = new HealthRecorder({
      read: async (now) => assessServerHealth(proc(), [base({ tradeTimes: [] })], now),
      store: fakeStore(), alertSettings: () => ({ tenantId: "t-off", enabled: false, cooldownMs: COOL }), instanceId: "i1", log: (m) => logs.push(m),
    });
    assert.deepEqual((await rec.tick(NOW)).alerts, []);
    assert.equal(stallAlerts.has("t-off"), false);
    assert.ok(logs.some((l) => /healthStallAlert is off/.test(l)));
  });
  it("never throws: a failed read or a failed write is logged", async () => {
    const logs: string[] = [];
    const bad = new HealthRecorder({ read: async () => { throw new Error("db down"); }, store: fakeStore(), alertSettings: () => undefined, instanceId: "i1", log: (m) => logs.push(m) });
    await bad.tick(NOW);
    const failingStore = { recordHealthSamples: async () => { throw new Error("write refused"); }, pruneHealthSamples: async () => { throw new Error("nope"); } };
    const bad2 = new HealthRecorder({ read: async (now) => assessServerHealth(proc(), [base()], now), store: failingStore, alertSettings: () => undefined, instanceId: "i1", log: (m) => logs.push(m) });
    await bad2.tick(NOW);
    assert.ok(logs.some((l) => /reading failed: db down/.test(l)));
    assert.ok(logs.some((l) => /could not store the reading: write refused/.test(l)));
  });
});

describe("health push detector", () => {
  it("turns a raised stall alert into one critical event and is silent otherwise", () => {
    const snap: any = { now: NOW, approvals: [], stranded: [], attention: [] };
    assert.deepEqual(healthDetector.detect(snap), []);
    const ev = healthDetector.detect({ ...snap, health: { key: "health:stall:1", title: "THEO: engine STALLED", body: "x" } });
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.severity, "critical");
    assert.equal(ev[0]!.category, "health");
  });
});
