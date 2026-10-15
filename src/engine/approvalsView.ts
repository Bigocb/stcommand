/**
 * What the Approvals screen shows: requests still awaiting a decision, decided ones the engine hasn't picked up yet,
 * and priority markets still waiting for a ship to dock there. Shared by GET /api/approvals and the live feed, so both
 * send the same thing.
 */
import type { Store } from "../db/store.js";
import type { FleetManager } from "./fleet.js";

export async function approvalsView(store: Store, fleet: FleetManager, tenantId: string) {
  const approvals = await store.listOpenApprovals(tenantId);
  // Decided but not yet picked up by the engine: shown so a decision never disappears into the gap before it acts.
  const decided = await store.listDecidedApprovals(tenantId);
  // Keeper-probe asks pack their target market into shipSymbol ("buyAt|target|hull"). A priority market that already
  // has an open ask isn't "coming up": it's already on the page. The rest are waiting for a ship to dock there, since
  // the engine only asks when a ship visits a market (one open request per kind, so the next one can't be queued yet).
  const asked = new Set([...approvals, ...decided].map((a) => String(a.shipSymbol ?? "").split("|")[1]).filter(Boolean));
  const upcoming = (await fleet.priorityUncovered()).filter((m) => !asked.has(m));
  return { approvals, decided, upcoming };
}
