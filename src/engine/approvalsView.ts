/**
 * What the Approvals screen shows: requests still awaiting a decision, decided ones the engine hasn't picked up yet,
 * and keeper priority markets with no open ask yet. Shared by GET /api/approvals and the live feed, so both send the
 * same thing.
 */
import type { Store } from "../db/store.js";
import type { FleetManager } from "./fleet.js";

export async function approvalsView(store: Store, fleet: FleetManager, tenantId: string) {
  const approvals = await store.listOpenApprovals(tenantId);
  // Decided but not yet picked up by the engine: shown so a decision never disappears into the gap before it acts.
  const decided = await store.listDecidedApprovals(tenantId);
  // Keeper-probe asks pack their target market into shipSymbol ("buyAt|target|hull"). A priority market that already
  // has an open ask isn't "coming up": it's already on the page. The rest are priority markets with no open ask yet —
  // approving one tags it through POST /api/keeper/markets, which runs the same immediate coverage check, so a keeper
  // card appears right away. No ship has to visit the market for that.
  const asked = new Set([...approvals, ...decided].map((a) => String(a.shipSymbol ?? "").split("|")[1]).filter(Boolean));
  const upcoming = (await fleet.priorityUncovered()).filter((m) => !asked.has(m));
  return { approvals, decided, upcoming };
}
