/**
 * When a ship that is mid-flight can next do anything: its arrival time.
 *
 * The feed and mission loops read each crew ship's state on every pass and
 * returned early when it was still in transit — so a carrier on a ten-minute
 * leg (or a collector on a long haul) was re-read every few seconds the whole
 * way, about a third of the game-API budget in one measurement. A ship in
 * flight can't act until it lands, so the loops now sleep it until then.
 *
 * Capped, so a bad or far-future arrival can never park a ship forever, and
 * undefined (read it again next pass, as before) when the ship isn't in
 * transit or the response carries no usable arrival time.
 */
export const MAX_TRANSIT_SKIP_MS = 30 * 60_000;

export function transitResumeAt(
  ship: { nav: { status: string; route?: { arrival?: string } } },
  now: number = Date.now(),
): number | undefined {
  if (ship.nav.status !== "IN_TRANSIT") return undefined;
  const arrival = ship.nav.route?.arrival ? Date.parse(ship.nav.route.arrival) : Number.NaN;
  if (!Number.isFinite(arrival)) return undefined;
  return Math.min(Math.max(arrival + 1_000, now), now + MAX_TRANSIT_SKIP_MS);
}
