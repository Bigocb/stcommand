import type { TenantWorker } from "./tenantRegistry.js";
import { orderNearest } from "./surveyTour.js";

/**
 * Start a survey tour for a surveyor: reorder the fields nearest-first from the ship's position (when asked), then hand the plan
 * to the fleet. One door for the MCP tool and the dashboard so both order and validate the same way.
 */
export async function startSurveyTour(
  w: Pick<TenantWorker, "fleet" | "state">,
  a: { shipSymbol: string; fields: string[]; batchesPerField: number; loop: boolean; nearestFirst: boolean },
): Promise<string[]> {
  let order = a.fields.map((f) => f.trim().toUpperCase()).filter(Boolean);
  if (a.nearestFirst) {
    const st = w.state.get() as { waypoints?: { symbol: string; x: number; y: number }[]; ships?: { symbol: string; nav?: { waypointSymbol?: string } }[] };
    const coords = new Map((st.waypoints ?? []).map((p) => [p.symbol, { x: p.x, y: p.y }]));
    const here = st.ships?.find((x) => x.symbol === a.shipSymbol)?.nav?.waypointSymbol;
    order = orderNearest(order, coords, here ? coords.get(here) : undefined);
  }
  await w.fleet.startFieldScan(a.shipSymbol, order, a.batchesPerField, a.loop);
  return order;
}
