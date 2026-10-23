import type { Store } from "../../db/store.js";
import type { FleetManager } from "../fleet.js";
import { paceFromBuckets } from "../pace.js";
import { resetWatcherStatus } from "../resetWatcher.js";
import type { NotifySnapshot } from "./types.js";

/**
 * Reads the live fleet into the small snapshot the detectors work from. The only part of the notification system that
 * knows what a FleetManager or Store looks like; everything else takes a NotifySnapshot.
 *
 * Approvals come from the database (a cheap indexed read) every pass; the pace needs a ledger read, so it is refreshed
 * at most every five minutes.
 */
const RATE_REFRESH_MS = 5 * 60_000;

export function liveSnapshotProvider(deps: { tenantId: string; store: Store; fleet: FleetManager; now?: () => number }): () => Promise<NotifySnapshot> {
  const now = deps.now ?? Date.now;
  let rate: NotifySnapshot["rate"];
  let rateAt = 0;
  return async () => {
    const t = now();
    const approvals = (await deps.store.listOpenApprovals(deps.tenantId)).map((a) => ({ id: a.id, kind: a.kind, shipSymbol: a.shipSymbol }));
    if (t - rateAt >= RATE_REFRESH_MS) {
      rateAt = t;
      try {
        const pace = paceFromBuckets(await deps.store.tradingPaceBuckets(deps.tenantId, 6, 15), 15);
        rate = { perHour1h: pace.perHour1h, perHour3h: pace.perHour3h };
      } catch {
        rate = undefined; // a failed read says nothing about the rate; the detector stays quiet
      }
    }
    const nextReset = Date.parse(resetWatcherStatus()?.nextReset ?? "");
    return {
      now: t,
      approvals,
      stranded: deps.fleet.getStrandedShips().map((s: { symbol: string }) => ({ symbol: s.symbol })),
      attention: deps.fleet.attention.snapshot().items.map((i) => ({ ship: i.ship, severity: i.severity, reasons: i.reasons.map((r) => ({ text: r.text, severity: r.severity })) })),
      msToReset: Number.isFinite(nextReset) ? nextReset - t : undefined,
      rate,
    };
  };
}
