/**
 * Gathers the admin health board's inputs from what the process already has (src/engine/serverHealth.ts holds the
 * logic and thresholds). Every source here existed before the board: the ledger (trade times, matched profit), the
 * fleet's idle tracker and loop pass timings, the ship-task scheduler's counters, ops `stuck`, the instance heartbeat
 * table and the shared rate limiter's 5-minute stats. Read-only; no game-API calls.
 */
import type { TenantWorker } from "../engine/tenantRegistry.js";
import type { Store } from "../db/store.js";
import { INSTANCE_ID, rateLimitMonitor } from "../core/rateLimitMonitor.js";
import { OPS_BY_NAME } from "./catalog.js";
import { processHistory } from "./containerStats.js";
import { processMemorySample, readCgroupMemory } from "./containerRead.js";
import { DEFAULT_HEALTH_POLICY, assessServerHealth, type HealthPolicy, type HealthReport, type ProcessInput, type TenantHealthInput } from "../engine/serverHealth.js";

export interface HealthSources {
  tenants: { id: string; agentSymbol: string }[];
  worker: (tenantId: string) => TenantWorker | undefined;
  /** For the instance heartbeat table (not tenant data). */
  store: Pick<Store, "opsInstances">;
  now: number;
  uptimeMs: number;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function tenantHealthInput(agent: string, w: TenantWorker | undefined, now: number, p: HealthPolicy = DEFAULT_HEALTH_POLICY): Promise<TenantHealthInput & { errors?: string[] }> {
  if (!w) return { agent, booted: false };
  const errors: string[] = [];
  const summary = w.fleet.fleetStatusSummary();
  const traders = summary.filter((s) => s.role === "trader").map((s) => ({ symbol: s.symbol, ...(s.idleSince !== undefined ? { idleSince: s.idleSince } : {}) }));

  let tradeTimes: number[] = [];
  let profitLastHour: number | null = null;
  try {
    const rows = await w.store.ledgerRowsSince(w.tenantId, new Date(now - p.windowMs).toISOString());
    tradeTimes = rows.filter((r) => r.type === "PURCHASE" || r.type === "SELL").map((r) => r.ts);
    profitLastHour = rows.filter((r) => r.type === "SELL" && r.pnl !== null && r.ts >= now - 3_600_000).reduce((n, r) => n + (r.pnl ?? 0), 0);
  } catch (err) { errors.push(`ledger: ${errText(err)}`); }

  let stuck: { crit: number; warn: number } | null = null;
  try {
    const r = (await OPS_BY_NAME.get("stuck")!.run({ w, now: () => now }, {})) as { counts: { crit: number; warn: number } };
    stuck = { crit: r.counts.crit, warn: r.counts.warn };
  } catch (err) { errors.push(`stuck: ${errText(err)}`); }

  let scheduler: { queue: number; idleSeconds: number } | null = null;
  try { const s = w.scheduler.stats_(); scheduler = { queue: s.queue, idleSeconds: s.idleSeconds }; } catch (err) { errors.push(`scheduler: ${errText(err)}`); }

  return {
    agent,
    booted: true,
    deadToken: w.api.deadTokenReason() ?? null,
    paused: w.fleet.isPaused(),
    tradeTimes,
    traders,
    stuck,
    wallet: w.state.get()?.agent?.credits ?? null,
    profitLastHour,
    loops: w.fleet.passTimings(now),
    scheduler,
    ...(errors.length ? { errors } : {}),
  };
}

export async function processHealthInput(store: Pick<Store, "opsInstances"> & Partial<Pick<Store, "instanceHistory">>, uptimeMs: number): Promise<ProcessInput & { errors?: string[] }> {
  const errors: string[] = [];
  let instances: ProcessInput["instances"] = [];
  try { instances = await store.opsInstances(6); } catch (err) { errors.push(`instances: ${errText(err)}`); }
  // Memory now and how the previous process ended (src/ops/containerStats.ts, migration 070).
  let memory: ProcessInput["memory"] = null;
  try {
    const s = processMemorySample();
    const cg = readCgroupMemory();
    memory = { ...s, cgroupPeakMb: cg.peakBytes === null ? null : Math.round(cg.peakBytes / 1048576) };
  } catch (err) { errors.push(`memory: ${errText(err)}`); }
  let lastRestart: ProcessInput["lastRestart"] = null;
  if (store.instanceHistory) {
    try {
      const hist = processHistory(await store.instanceHistory(48));
      const me = hist.findIndex((h) => h.instanceId === INSTANCE_ID);
      const prev = me > 0 ? hist[me - 1] : me < 0 && hist.length > 0 ? hist[hist.length - 1] : undefined;
      if (prev) lastRestart = { endedAt: prev.lastSeen, kind: prev.end.kind, reason: prev.end.reason, ...(prev.end.gapSec !== undefined ? { gapSec: prev.end.gapSec } : {}) };
    } catch (err) { errors.push(`restart history: ${errText(err)}`); }
  }
  const snap = rateLimitMonitor.snapshot();
  const st = snap.limiter;
  return {
    uptimeMs,
    instanceId: INSTANCE_ID,
    instances,
    api: st ? {
      callsPerMin: st.callsPerMin, cap: st.ratePerMin, queueDepth: st.queueDepth, oldestWaitMs: st.oldestWaitMs,
      avgWaitMs: st.avgWaitMs, maxWaitMs: st.maxWaitMs, hits429Last60s: snap.hits60s, windowMin: Math.round(st.windowMs / 60_000),
    } : null,
    memory,
    lastRestart,
    ...(errors.length ? { errors } : {}),
  };
}

/** The board for every tenant booted in this process; tenants with no engine here are listed by name only. */
export async function gatherServerHealth(src: HealthSources, p: HealthPolicy = DEFAULT_HEALTH_POLICY): Promise<HealthReport & { notBooted: string[]; errors: string[] }> {
  const booted = src.tenants.filter((t) => src.worker(t.id));
  const notBooted = src.tenants.filter((t) => !src.worker(t.id)).map((t) => t.agentSymbol);
  const [pr, ...inputs] = await Promise.all([
    processHealthInput(src.store, src.uptimeMs),
    ...booted.map((t) => tenantHealthInput(t.agentSymbol, src.worker(t.id), src.now, p)),
  ]) as [ProcessInput & { errors?: string[] }, ...(TenantHealthInput & { errors?: string[] })[]];
  const errors = [...(pr.errors ?? []), ...inputs.flatMap((i) => (i.errors ?? []).map((e) => `${i.agent}: ${e}`))];
  return { ...assessServerHealth(pr, inputs, src.now, p), notBooted, errors };
}
