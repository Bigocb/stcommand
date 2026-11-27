import type pg from "pg";
import type { TenantRegistry } from "./tenantRegistry.js";
import { Store } from "../db/store.js";
import { INSTANCE_ID } from "../core/rateLimitMonitor.js";
import { gatherServerHealth } from "../ops/serverHealthSources.js";
import { EMPTY_ALERT_STATE, decideStallAlert, healthSampleRows, type HealthReport, type HealthSampleRow, type StallAlertState } from "./serverHealth.js";
import { cpuAlerts, stallAlerts } from "./stallAlerts.js";
import { EMPTY_CPU_ALERT, decideCpuAlert, type CpuAlertState } from "./cpuHealth.js";

/**
 * Phase 2 of the admin health board: once a minute, take the same reading the board shows, store it (health_samples,
 * migration 068) so the board can chart the last 6 hours, and raise the stall alert when serverHealth.ts's
 * decideStallAlert() says so. The alert is one loud log line plus a Tower push through the existing notification pass
 * (stallAlerts -> notify/live.ts -> the health detector), so it reaches only devices that turned notifications on.
 *
 * Nothing here may break the engine: every step is wrapped, a failure is logged and the next minute tries again, and a
 * reading still running when the next one is due is skipped.
 */

export const HEALTH_SAMPLE_MS = 60_000;
export const HEALTH_KEEP_MS = 7 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;

export interface HealthRecorderDeps {
  /** The board's reading now. */
  read: (now: number) => Promise<HealthReport>;
  store: { recordHealthSamples(instanceId: string, rows: HealthSampleRow[]): Promise<void>; pruneHealthSamples(beforeIso: string): Promise<number> };
  /** Per agent: its tenant id and whether the alert clause is on, with its cool-down. Undefined when no engine runs for it here. */
  alertSettings: (agent: string) => { tenantId: string; enabled: boolean; cooldownMs: number; cpuEnabled?: boolean; cpuHoldMs?: number } | undefined;
  instanceId: string;
  log: (msg: string) => void;
}

export class HealthRecorder {
  private busy = false;
  private lastPruneAt = 0;
  private readonly alertState = new Map<string, StallAlertState>();
  /** Box-CPU alert state, process-wide. In memory on purpose: a restart is what clears a hot spell, and the new process measures afresh. */
  private cpuState: CpuAlertState = EMPTY_CPU_ALERT;

  constructor(private readonly deps: HealthRecorderDeps) {}

  /** One reading: store it, then the alert. Never throws. */
  async tick(now: number): Promise<{ stored: number; alerts: string[] }> {
    const out = { stored: 0, alerts: [] as string[] };
    if (this.busy) return out;
    this.busy = true;
    try {
      let report: HealthReport;
      try { report = await this.deps.read(now); } catch (err) { this.deps.log(`health: reading failed: ${msg(err)}`); return out; }
      const rows = healthSampleRows(report, now);
      try { await this.deps.store.recordHealthSamples(this.deps.instanceId, rows); out.stored = rows.length; } catch (err) { this.deps.log(`health: could not store the reading: ${msg(err)}`); }
      if (now - this.lastPruneAt >= PRUNE_EVERY_MS) {
        this.lastPruneAt = now;
        try { await this.deps.store.pruneHealthSamples(new Date(now - HEALTH_KEEP_MS).toISOString()); } catch (err) { this.deps.log(`health: prune failed: ${msg(err)}`); }
      }
      for (const t of report.tenants) {
        try {
          const settings = this.deps.alertSettings(t.agent);
          if (!settings) continue;
          if (!t.heartbeat.stalled) stallAlerts.delete(settings.tenantId);
          const d = decideStallAlert(this.alertState.get(t.agent) ?? EMPTY_ALERT_STATE, t, now, settings.cooldownMs);
          this.alertState.set(t.agent, d.state);
          if (!d.alert) continue;
          if (!settings.enabled) { this.deps.log(`health: ${t.agent} reads STALLED; the alert clause healthStallAlert is off, so no push`); continue; }
          this.deps.log(`HEALTH ALERT ${"!".repeat(10)} ${d.title}: ${d.body}`);
          stallAlerts.set(settings.tenantId, { key: `health:stall:${now}`, title: d.title!, body: d.body! });
          out.alerts.push(t.agent);
        } catch (err) { this.deps.log(`health: alert check failed for ${t.agent}: ${msg(err)}`); }
      }
      try { this.checkCpu(report, now, out); } catch (err) { this.deps.log(`health: cpu alert check failed: ${msg(err)}`); }
      return out;
    } finally {
      this.busy = false;
    }
  }

  /** The box-CPU alert: process-wide, pushed to every agent whose clause healthCpuAlert is on (cpuHealth.ts). */
  private checkCpu(report: HealthReport, now: number, out: { alerts: string[] }): void {
    const tile = report.process.find((x) => x.key === "cpu");
    if (!tile) return;
    const agents = report.tenants.map((t) => ({ agent: t.agent, s: this.deps.alertSettings(t.agent) })).filter((x) => x.s !== undefined);
    const on = agents.filter((x) => x.s!.cpuEnabled);
    if (tile.level !== "bad") for (const x of agents) cpuAlerts.delete(x.s!.tenantId);
    const holdMs = Math.min(...on.map((x) => x.s!.cpuHoldMs ?? 10 * 60_000), Infinity);
    const d = decideCpuAlert(this.cpuState, tile, report.server.uptimeMs, now, Number.isFinite(holdMs) ? holdMs : 10 * 60_000, 60 * 60_000);
    this.cpuState = d.state;
    if (!d.alert) return;
    if (on.length === 0) { this.deps.log(`health: box CPU reads ${tile.word} (${tile.value}); the alert clause healthCpuAlert is off, so no push`); return; }
    this.deps.log(`HEALTH ALERT ${"!".repeat(10)} ${d.title}: ${d.body}`);
    for (const x of on) { cpuAlerts.set(x.s!.tenantId, { key: `health:cpu:${now}`, title: d.title!, body: d.body! }); out.alerts.push(`${x.agent}:cpu`); }
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Start the minute timer in the server process. Returns a stop function. */
export function startHealthRecorder(pool: pg.Pool, registry: TenantRegistry, log: (msg: string) => void): () => void {
  const store = new Store(pool);
  const recorder = new HealthRecorder({
    read: (now) => {
      const workers = registry.workersSnapshot();
      return gatherServerHealth({
        tenants: workers.map((w) => ({ id: w.tenantId, agentSymbol: w.agentSymbol })),
        worker: (id) => registry.get(id), store, now, uptimeMs: Math.round(process.uptime() * 1000),
      });
    },
    store,
    alertSettings: (agent) => {
      const w = registry.workersSnapshot().find((x) => x.agentSymbol === agent);
      if (!w) return undefined;
      const d = w.fleet.doctrine;
      return {
        tenantId: w.tenantId, enabled: d.isEnabled("healthStallAlert"), cooldownMs: d.value("healthStallAlert", 15) * 60_000,
        cpuEnabled: d.isEnabled("healthCpuAlert"), cpuHoldMs: d.value("healthCpuAlert", 10) * 60_000,
      };
    },
    instanceId: INSTANCE_ID,
    log,
  });
  const timer = setInterval(() => { recorder.tick(Date.now()).catch(() => {}); }, HEALTH_SAMPLE_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
