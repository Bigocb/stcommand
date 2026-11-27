import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CPU_POLICY as P, EMPTY_CPU_ALERT, cpuShare, cpuTile, decideCpuAlert, trimCpuSamples } from "../src/engine/cpuHealth.js";
import { assessServerHealth, healthSampleRows, type ProcessInput } from "../src/engine/serverHealth.js";
import { HealthRecorder } from "../src/engine/healthRecorder.js";
import { cpuAlerts } from "../src/engine/stallAlerts.js";
import { cpuDetector } from "../src/engine/notify/detectors.js";
import { CATEGORIES } from "../src/engine/notify/categories.js";

const NOW = Date.parse("2026-11-27T06:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
/** One sample a minute for `n` minutes at `share` of a core, ending at `end`. */
const samples = (n: number, share: number, end = NOW) => Array.from({ length: n + 1 }, (_, i) => ({ at: end - (n - i) * MIN, cpuUs: i * MIN * 1000 * share }));
const proc = (cpu: ProcessInput["cpu"], uptimeMs = 12 * HOUR): ProcessInput => ({
  uptimeMs, instanceId: "box-1", instances: [{ instanceId: "box-1", startedAt: "", lastSeen: "", aliveNow: true }],
  api: { callsPerMin: 80, cap: 105, queueDepth: 0, oldestWaitMs: 0, avgWaitMs: 0, maxWaitMs: 0, hits429Last60s: 0, windowMin: 5 }, cpu,
});

describe("cpuHealth: share", () => {
  it("is CPU time over wall time across the window", () => {
    const c = cpuShare(samples(10, 0.56), NOW, P.windowMs)!;
    assert.ok(Math.abs(c.share - 0.56) < 1e-9);
    assert.equal(c.spanMs, 10 * MIN);
  });
  it("keeps one sample at or before the window start, drops older ones", () => {
    assert.equal(trimCpuSamples(samples(30, 0.5), NOW, P.windowMs).length, 11);
  });
  it("is null until a minute of samples exists (a fresh restart)", () => {
    assert.equal(cpuShare([{ at: NOW, cpuUs: 0 }], NOW, P.windowMs), null);
    assert.equal(cpuShare([{ at: NOW - 30_000, cpuUs: 0 }, { at: NOW, cpuUs: 1 }], NOW, P.windowMs), null);
  });
});

describe("cpuHealth: tile", () => {
  it("reads OK at 56%, BUSY at 85%, HOT at 95% and over", () => {
    assert.equal(cpuTile({ share: 0.56, spanMs: 10 * MIN, loopP99Ms: 65 }).word, "OK");
    assert.equal(cpuTile({ share: 0.9, spanMs: 10 * MIN, loopP99Ms: 65 }).level, "warn");
    const hot = cpuTile({ share: 1.06, spanMs: 10 * MIN, loopP99Ms: 65 });
    assert.equal(hot.level, "bad");
    assert.equal(hot.value, "106%");
    assert.match(hot.detail, /restart/);
  });
  it("reads HOT on a long event-loop delay even at a modest share", () => {
    assert.equal(cpuTile({ share: 0.5, spanMs: 10 * MIN, loopP99Ms: 2500 }).level, "bad");
  });
  it("says MEASURING (and stays ok) while the window fills", () => {
    const t = cpuTile({ share: null, spanMs: null, loopP99Ms: null });
    assert.equal(t.word, "MEASURING");
    assert.equal(t.level, "ok");
  });
  it("sits on the board with the process tiles and goes into the stored server row", () => {
    const r = assessServerHealth(proc({ share: 0.97, spanMs: 10 * MIN, loopP99Ms: 120 }), [], NOW);
    assert.equal(r.process.find((x) => x.key === "cpu")?.word, "HOT");
    const row = healthSampleRows(r, NOW)[0]!;
    assert.equal(row.cpuPct, 97);
    assert.equal(row.loopP99Ms, 120);
  });
});

describe("cpuHealth: alert", () => {
  const hot = cpuTile({ share: 1.0, spanMs: 10 * MIN, loopP99Ms: 50 });
  const ok = cpuTile({ share: 0.5, spanMs: 10 * MIN, loopP99Ms: 50 });
  it("waits for the hot spell to hold, alerts once, and again only after it cools and the cool-down passes", () => {
    let s = EMPTY_CPU_ALERT;
    let d = decideCpuAlert(s, hot, 12 * HOUR, NOW, 10 * MIN, HOUR); s = d.state;
    assert.equal(d.alert, false);
    d = decideCpuAlert(s, hot, 12 * HOUR, NOW + 10 * MIN, 10 * MIN, HOUR); s = d.state;
    assert.equal(d.alert, true);
    assert.match(d.body!, /12 h uptime/);
    d = decideCpuAlert(s, hot, 12 * HOUR, NOW + 11 * MIN, 10 * MIN, HOUR); s = d.state;
    assert.equal(d.alert, false, "once per hot spell");
    d = decideCpuAlert(s, ok, 12 * HOUR, NOW + 12 * MIN, 10 * MIN, HOUR); s = d.state;
    assert.equal(s.hotSince, null);
    d = decideCpuAlert(s, hot, 12 * HOUR, NOW + 20 * MIN, 10 * MIN, HOUR); s = d.state;
    d = decideCpuAlert(s, hot, 12 * HOUR, NOW + 30 * MIN, 10 * MIN, HOUR); s = d.state;
    assert.equal(d.alert, false, "inside the hour's cool-down");
    d = decideCpuAlert(s, hot, 12 * HOUR, NOW + 71 * MIN, 10 * MIN, HOUR);
    assert.equal(d.alert, true);
  });
});

describe("cpuHealth: recorder and push (the seam)", () => {
  const fakeStore = () => ({ recordHealthSamples: async () => {}, pruneHealthSamples: async () => 0 });
  it("pushes through the cpu detector after the hold, and clears when the box cools", async () => {
    let share = 1.02;
    const logs: string[] = [];
    const rec = new HealthRecorder({
      read: async (now) => assessServerHealth(proc({ share, spanMs: 10 * MIN, loopP99Ms: 80 }), [{ agent: "THEO", booted: true, paused: false, tradeTimes: [now - MIN], traders: [], stuck: { crit: 0, warn: 0 }, wallet: 1, profitLastHour: 1, loops: [], scheduler: { queue: 0, idleSeconds: 0 } }], now),
      store: fakeStore(), instanceId: "i1", log: (m) => logs.push(m),
      alertSettings: () => ({ tenantId: "t-cpu", enabled: true, cooldownMs: 15 * MIN, cpuEnabled: true, cpuHoldMs: 10 * MIN }),
    });
    await rec.tick(NOW);
    assert.equal(cpuAlerts.has("t-cpu"), false, "not before the hold");
    assert.deepEqual((await rec.tick(NOW + 10 * MIN)).alerts, ["THEO:cpu"]);
    const a = cpuAlerts.get("t-cpu")!;
    assert.match(a.title, /Box CPU 102%/);
    const ev = cpuDetector.detect({ now: NOW, approvals: [], stranded: [], attention: [], cpu: a } as any);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.category, "cpu");
    assert.ok(CATEGORIES.some((c) => c.id === "cpu"));
    assert.equal(logs.filter((l) => l.startsWith("HEALTH ALERT")).length, 1);
    share = 0.5;
    await rec.tick(NOW + 11 * MIN);
    assert.equal(cpuAlerts.has("t-cpu"), false, "cleared when it cools");
  });
  it("logs but does not push with the clause off", async () => {
    const logs: string[] = [];
    const rec = new HealthRecorder({
      read: async (now) => assessServerHealth(proc({ share: 1.2, spanMs: 10 * MIN, loopP99Ms: 80 }), [{ agent: "THEO", booted: true, paused: false, tradeTimes: [now - MIN], traders: [], stuck: { crit: 0, warn: 0 }, wallet: 1, profitLastHour: 1, loops: [], scheduler: { queue: 0, idleSeconds: 0 } }], now),
      store: fakeStore(), instanceId: "i1", log: (m) => logs.push(m),
      alertSettings: () => ({ tenantId: "t-cpu-off", enabled: true, cooldownMs: 15 * MIN, cpuEnabled: false }),
    });
    await rec.tick(NOW);
    await rec.tick(NOW + 10 * MIN);
    assert.equal(cpuAlerts.has("t-cpu-off"), false);
    assert.ok(logs.some((l) => /healthCpuAlert is off/.test(l)));
  });
});
