/**
 * Per-ship lot policy: how big one buy call may be, and how many market lots one trip may buy.
 *
 * Why this exists: the trip size was set only by the fleet-wide `maxLotsPerTrip` doctrine rule and each market's own
 * tradeVolume. An operator (or future automation) wanting a gentler pace on one hull, say a thin market or a ship on a
 * long positioning leg, had no per-ship knob. A trip's volume is min(hold, wallet, lotSize x maxLots), so a lotSize cap
 * shrinks the whole trip, not just the individual buy call.
 *
 * Pure. No I/O, no clock. The fleet persists the map and passes each ship's policy into the trader as plain values.
 * Zero (or an absent field) means "no override": the market's tradeVolume and the doctrine rule apply as before.
 */

export interface ShipLotPolicy {
  /** Units per buy call at most. Undefined = the market's own tradeVolume is the only limit. */
  lotSize?: number;
  /** Market lots one trip may buy. Undefined = the fleet's doctrine maxLotsPerTrip. */
  maxLots?: number;
}

export const SHIP_LOT_LIMITS = {
  lotSize: { min: 1, max: 1000 },
  maxLots: { min: 1, max: 12 },
} as const;

/** The lot size a trader plans and buys with: the smaller of the market's tradeVolume and the ship's cap. */
export function effectiveLotSize(marketLot: number, policy?: ShipLotPolicy): number {
  const cap = policy?.lotSize;
  if (cap === undefined || cap <= 0) return marketLot;
  return Math.min(marketLot, cap);
}

/** The lots one trip may buy: the ship's own count when set, else the fleet doctrine value. */
export function effectiveMaxLots(doctrineMaxLots: number, policy?: ShipLotPolicy): number {
  const lots = policy?.maxLots;
  return lots !== undefined && lots > 0 ? lots : doctrineMaxLots;
}

/**
 * Validate operator input. 0, null or undefined on a field means "unset" (back to the default for that field).
 * Returns undefined when neither field is set, so the caller can drop the ship's entry. Throws with a one-line
 * reason on an out-of-range or non-integer value.
 */
export function normalizeShipLotPolicy(input: { lotSize?: number | null; maxLots?: number | null }): ShipLotPolicy | undefined {
  const out: ShipLotPolicy = {};
  for (const field of ["lotSize", "maxLots"] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === 0) continue;
    const { min, max } = SHIP_LOT_LIMITS[field];
    if (!Number.isInteger(raw) || raw < min || raw > max) {
      throw new Error(`${field} must be a whole number from ${min} to ${max} (or 0 to clear), got ${raw}`);
    }
    out[field] = raw;
  }
  return out.lotSize === undefined && out.maxLots === undefined ? undefined : out;
}
