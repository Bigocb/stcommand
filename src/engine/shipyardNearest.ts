/**
 * Nearest shipyard for a "send to shipyard" control: which yard in a system is closest to where a ship is or is
 * heading.
 *
 * Pure. The caller (FleetManager.nearestShipyardFor()) fills in the ship's position and the system's known yards and
 * acts on the answer. Straight-line distance in galaxy units, the same measure the warp and fuel planners use, so the
 * pick agrees with what a flight would cost in a single leg.
 */

export interface YardCandidate {
  symbol: string;
  x: number;
  y: number;
}

export interface NearestYard {
  symbol: string;
  distance: number;
  /** One-line reason, for the activity log. */
  reason: string;
}

/** Closest candidate to `from`, or undefined when there are none. Ties go to the alphabetically first symbol, so the
 *  same inputs always give the same yard. */
export function nearestShipyard(from: { x: number; y: number }, candidates: YardCandidate[]): NearestYard | undefined {
  let best: NearestYard | undefined;
  for (const c of candidates) {
    const distance = Math.round(Math.hypot(c.x - from.x, c.y - from.y));
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && c.symbol < best.symbol)
    ) {
      best = { symbol: c.symbol, distance, reason: "" };
    }
  }
  if (best) {
    best.reason = `closest of ${candidates.length} shipyard${candidates.length === 1 ? "" : "s"} in the system, ${best.distance} units away`;
  }
  return best;
}
