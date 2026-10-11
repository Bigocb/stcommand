/**
 * Why a trader is not offered to the route dispatcher.
 *
 * The dispatcher only ever sees the traders FleetManager.dispatcherTraders() lets through, so a ship that is held, suspended
 * or claimed by another controller never appears in its per-route rejections, and "why isn't it getting a route" had no
 * answer (2026-10-11, two traders on the new server idle next to good routes). This turns the same facts into one plain
 * sentence. Pure: the fleet fills TraderFacts, this decides, and the two stay in step through the test at the seam.
 */
export interface TraderFacts {
  symbol: string;
  isWarehouse: boolean;
  held: boolean;
  /** A hold replayed from saved state at boot rather than placed this session. */
  restoredHold: boolean;
  suspended: boolean;
  /** Current claim owner, if any ("trading" is the dispatcher's own and does not exclude). */
  claimOwner?: string;
  claimIntent?: string;
  /** Marked to be scrapped. */
  scrapping: boolean;
  cargoUnits: number;
  /** True when the fleet's own availability check (the registry) says the "auto" owner could take it. */
  availableForAuto: boolean;
}

/** The reason the dispatcher is not considering this trader, or undefined when it is. */
export function dispatchExclusion(f: TraderFacts): string | undefined {
  if (f.isWarehouse) return "it is the warehouse ship";
  if (!f.availableForAuto && f.claimOwner !== "trading") {
    if (f.held) {
      return f.restoredHold
        ? "held by a saved hold replayed when the server booted (release it to let the dispatcher use it)"
        : "held by the operator (release it to let the dispatcher use it)";
    }
    if (f.suspended) return "suspended by a controller that is driving it directly";
    if (f.claimOwner) return `claimed by ${f.claimOwner}${f.claimIntent ? ` (${f.claimIntent})` : ""}`;
    return "not available to the dispatcher";
  }
  if (f.scrapping && f.cargoUnits === 0) return "marked to be scrapped and its hold is empty";
  return undefined;
}
