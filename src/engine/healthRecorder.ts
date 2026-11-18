import type pg from "pg";
import type { TenantRegistry } from "./tenantRegistry.js";
import { Store } from "../db/store.js";
import { INSTANCE_ID } from "../core/rateLimitMonitor.js";
import { gatherServerHealth } from "../ops/serverHealthSources.js";
import { EMPTY_ALERT_STATE, decideStallAlert, healthSampleRows, type HealthReport, type HealthSampleRow, type StallAlertState } from "./serverHealth.js";
import { stallAlerts } from "./stallAlerts.js";

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
  alertSettings: (agent: string) => { tenantId: string; enabled: boolean; cooldownMs: number } | undefined;
  instanceId: string;
  log: (msg: string) => void;
}

export class HealthRecorder {
  private busy = false;
  private lastPruneAt = 0;
  private readonly alertState = new Map<string, StallAlertState>();

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
      return out;
    } finally {
      this.busy = false;
    }
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
      return { tenantId: w.tenantId, enabled: d.isEnabled("healthStallAlert"), cooldownMs: d.value("healthStallAlert", 15) * 60_000 };
    },
    instanceId: INSTANCE_ID,
    log,
  });
  const timer = setInterval(() => { recorder.tick(Date.now()).catch(() => {}); }, HEALTH_SAMPLE_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
