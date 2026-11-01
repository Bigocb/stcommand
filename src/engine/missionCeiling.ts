/**
 * Per-material price ceilings and lot sizes for a construction mission.
 *
 * `MissionPacing.maxPrice` is one number for every material the mission buys, so a gate that needs a cheap bulk material
 * (FAB_MATS, about 1,300-2,100 a unit) and a dear one (ADVANCED_CIRCUITRY, about 3,700) cannot hold the first to 2,000 and
 * still let the second buy at its own price. `maxPriceBy` gives each material its own absolute ceiling; a material with no
 * entry uses `maxPrice`, and with neither set the percentage ceiling over the material's baseline applies, as before.
 * Pure: no I/O, no clock.
 */
export interface CeilingPacing {
  maxPrice?: number;
  maxPriceBy?: Readonly<Record<string, number>>;
}

/** Per-material lot size: `buyLotUnitsBy[material]` overrides the mission-wide `buyLotUnits` for that material only. */
export interface LotPacing {
  buyLotUnits?: number;
  buyLotUnitsBy?: Readonly<Record<string, number>>;
}

/** The lot size (units per purchase) that applies to one material, or undefined when the market's own trade volume is the only cap. */
export function lotUnitsFor(pacing: LotPacing | null | undefined, material: string): number | undefined {
  return pacing?.buyLotUnitsBy?.[material] ?? pacing?.buyLotUnits;
}

/** The absolute ceiling (credits per unit) that applies to one material, or undefined when only the percentage ceiling does. */
export function maxPriceFor(pacing: CeilingPacing | null | undefined, material: string): number | undefined {
  return pacing?.maxPriceBy?.[material] ?? pacing?.maxPrice;
}

/**
 * Merge a per-material patch into the current per-material settings (ceilings or lot sizes). A number sets that material's value,
 * null or 0 clears it, a material not mentioned keeps its value, and a null patch clears them all. Materials must be ones the
 * mission needs; each value is a whole number within [min, max]. Returns undefined when nothing is left, so the key can be dropped.
 */
export function mergeByMaterial(
  label: string,
  current: Readonly<Record<string, number>> | undefined,
  patch: Readonly<Record<string, number | null>> | null,
  materials: readonly string[],
  min: number,
  max: number,
): Record<string, number> | undefined {
  if (patch === null) return undefined;
  const next: Record<string, number> = { ...(current ?? {}) };
  for (const [raw, v] of Object.entries(patch)) {
    const material = raw.trim().toUpperCase();
    if (!materials.includes(material)) throw new Error(`${label}: the mission has no material ${material}`);
    if (v === null || v === 0) { delete next[material]; continue; }
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label} ${material} must be between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")} (or null to clear)`);
    next[material] = Math.round(v);
  }
  return Object.keys(next).length ? next : undefined;
}

/** Per-material absolute price ceilings, 1 to 100,000,000 credits a unit. */
export function mergeMaxPriceBy(current: Readonly<Record<string, number>> | undefined, patch: Readonly<Record<string, number | null>> | null, materials: readonly string[]): Record<string, number> | undefined {
  return mergeByMaterial("maxPriceBy", current, patch, materials, 1, 100_000_000);
}

/** Per-material lot sizes, 1 to 1,000 units a purchase (the same range as the mission-wide lot). */
export function mergeBuyLotUnitsBy(current: Readonly<Record<string, number>> | undefined, patch: Readonly<Record<string, number | null>> | null, materials: readonly string[]): Record<string, number> | undefined {
  return mergeByMaterial("buyLotUnitsBy", current, patch, materials, 1, 1000);
}
