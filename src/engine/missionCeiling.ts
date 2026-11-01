/**
 * Per-material price ceilings for a construction mission.
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

/** The absolute ceiling (credits per unit) that applies to one material, or undefined when only the percentage ceiling does. */
export function maxPriceFor(pacing: CeilingPacing | null | undefined, material: string): number | undefined {
  return pacing?.maxPriceBy?.[material] ?? pacing?.maxPrice;
}

/**
 * Merge a patch into the current per-material ceilings. A number sets that material's ceiling, null or 0 clears it, a
 * material not mentioned keeps its value, and a null patch clears them all. Materials must be ones the mission needs; each
 * ceiling is a whole number from 1 to 100,000,000. Returns undefined when nothing is left, so the key can be dropped.
 */
export function mergeMaxPriceBy(
  current: Readonly<Record<string, number>> | undefined,
  patch: Readonly<Record<string, number | null>> | null,
  materials: readonly string[],
): Record<string, number> | undefined {
  if (patch === null) return undefined;
  const next: Record<string, number> = { ...(current ?? {}) };
  for (const [raw, v] of Object.entries(patch)) {
    const material = raw.trim().toUpperCase();
    if (!materials.includes(material)) throw new Error(`maxPriceBy: the mission has no material ${material}`);
    if (v === null || v === 0) { delete next[material]; continue; }
    if (!Number.isFinite(v) || v < 1 || v > 100_000_000) throw new Error(`maxPriceBy ${material} must be between 1 and 100,000,000 (or null to clear)`);
    next[material] = Math.round(v);
  }
  return Object.keys(next).length ? next : undefined;
}
