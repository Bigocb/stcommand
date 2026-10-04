import type { TenantRegistry } from "./tenantRegistry.js";

const SAMPLE_MS = 15 * 60_000;
const FIRST_SAMPLE_MS = 60_000;

/**
 * Samples every booted tenant's credits, ship count and role mix every 15
 * minutes into run_timeline (migration 037), so a week can be drawn as a
 * cash/fleet curve and compared with other weeks. Reads only in-memory state
 * (no game API calls). Best-effort: a failed write is logged and skipped.
 */
export function startRunTimeline(registry: TenantRegistry, log: (msg: string) => void): () => void {
  const sample = async () => {
    for (const w of registry.workersSnapshot()) {
      try {
        const snap = w.state.get();
        const roles: Record<string, number> = {};
        for (const s of w.fleet.fleetStatusSummary()) roles[s.role] = (roles[s.role] ?? 0) + 1;
        await w.store.recordRunTimeline(w.tenantId, {
          credits: snap.agent?.credits ?? null,
          shipCount: snap.ships.length,
          roles,
          buys: snap.totals?.buys,
          sells: snap.totals?.sells,
        });
      } catch (err) {
        log(`run timeline sample failed for ${w.agentSymbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const first = setTimeout(() => void sample(), FIRST_SAMPLE_MS);
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
