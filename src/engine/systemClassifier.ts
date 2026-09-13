/**
 * Play-style tracking's next step (docs/TODO.md): classify a tenant's home
 * system from the same attributes the checkpoint tool already captures
 * (market/shipyard/jump-gate counts, connectivity), then suggest a starter
 * doctrine template tuned for that archetype.
 *
 * Deliberately rule-based, not learned — this project's whole doctrine
 * system is explicit, operator-readable rules, not a black box, and the
 * inputs here are exactly the ones a human would look at to make the same
 * call by eye. The classification and every template value below are a
 * first-pass starting point, not a tuned result: apply-template only ever
 * proposes, the operator decides, and every value is editable afterward
 * the same as any other doctrine rule.
 */

export interface SystemAttributes {
  marketCount: number;
  shipyardCount: number;
  jumpGateCount: number;
  connectedSystemCount: number;
}

export type SystemArchetype = "isolated" | "market_desert" | "shipyard_poor" | "hub" | "standard";

export const ARCHETYPE_LABELS: Record<SystemArchetype, string> = {
  isolated: "Isolated (no jump gate out)",
  market_desert: "Market desert (little to trade locally)",
  shipyard_poor: "Shipyard-poor (markets, no local yard)",
  hub: "Hub (markets, a yard, well connected)",
  standard: "Standard",
};

/**
 * Order matters: isolated is checked first because it overrides everything
 * else (no gate means cross-system strategy is simply impossible, however
 * many markets sit locally); hub only fires once a system clears every bar
 * at once, not on any single strong attribute.
 */
export function classifySystem(attrs: SystemAttributes): SystemArchetype {
  if (attrs.jumpGateCount === 0 || attrs.connectedSystemCount === 0) return "isolated";
  if (attrs.marketCount <= 1) return "market_desert";
  if (attrs.shipyardCount === 0 && attrs.marketCount >= 2) return "shipyard_poor";
  if (attrs.marketCount >= 3 && attrs.shipyardCount >= 1 && attrs.connectedSystemCount >= 2) return "hub";
  return "standard";
}

export interface DoctrineTemplateEntry {
  key: string;
  value?: number;
  enabled?: boolean;
}

/**
 * Starter doctrine deltas per archetype — only the handful of keys each
 * archetype actually has an opinion about; everything else stays whatever
 * the tenant already has. "standard" has no template (nothing to suggest
 * over the catalog's own defaults).
 */
export const DOCTRINE_TEMPLATES: Record<SystemArchetype, DoctrineTemplateEntry[]> = {
  isolated: [
    // No gate out: a dedicated explorer or a jump-based exploring policy has
    // nowhere to go, so both are dead weight until a gate exists (if one is
    // even under construction here at all).
    { key: "explorerTarget", value: 0 },
    { key: "exploringEnabled", enabled: false },
    // Local production is the only income this system has — lean into it.
    { key: "minerTarget", value: 6 },
  ],
  market_desert: [
    // Little worth trading locally — push outward to find markets instead
    // of growing a local trading fleet that has nowhere good to sell.
    { key: "minerTarget", value: 2 },
    { key: "explorerTarget", value: 1 },
    { key: "exploringEnabled", enabled: true },
  ],
  shipyard_poor: [
    // A repair or a new hull means a trip out of system — catch wear earlier
    // rather than risk a ship stranding itself before it can reach a yard.
    { key: "repairConditionFloor", value: 0.65 },
  ],
  hub: [
    // Plenty of markets worth keeping fresh, and enough liquidity that
    // warehousing (buy low here, sell high across several local markets)
    // is worth turning on rather than leaving off by default.
    { key: "keeperCount", value: 3 },
    { key: "warehouseTarget", enabled: true },
  ],
  standard: [],
};
