/**
 * Which jump gate a rejected jump tells us about.
 *
 * A live "under construction" rejection is stronger evidence than the construction cache, and the cache is one-way (a gate
 * recorded complete is never asked about again), so the rejection is the only thing that can correct a wrong "complete".
 * The correction has to land on the gate the game names. The trader's handler used to flag the gate the ship was standing
 * at (its origin) whatever the message said. 2026-10-24: "Destination jump gate X1-JM97-I57 is under construction" came back
 * for jumps out of X1-RB54, the origin gate was flagged unfinished instead, and JM97 stayed recorded as finished: ships were
 * routed into it again and again (16:15, 16:17, 20:15, 20:19), and each rejection briefly marked the RB54 hub gate, which is
 * finished, as not.
 *
 * Pure: the message and the two gates in, one gate symbol (or nothing) out.
 */

export interface JumpEnds {
  /** The gate the ship is jumping from. */
  origin?: string;
  /** The gate it is jumping to. */
  destination?: string;
}

const GATE_SYMBOL = /\b([A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+)\b[^.]*construct/i;

/**
 * The gate to record as not complete for this rejection, or undefined when the message is not about a gate at all.
 *  - a message that names a gate before "under construction" flags that gate;
 *  - one that says "destination" without naming it flags the destination end;
 *  - anything else gate-related ("not complete", "not connected", construction with no gate named) keeps the old behaviour
 *    and flags the origin.
 */
export function gateFromJumpRejection(message: string, ends: JumpEnds): string | undefined {
  const construction = /construct/i.test(message);
  if (!construction && !/not complete|not connected/i.test(message)) return undefined;
  if (construction) {
    const named = GATE_SYMBOL.exec(message)?.[1];
    if (named) return named.toUpperCase();
    if (/destination/i.test(message) && ends.destination) return ends.destination;
  }
  return ends.origin;
}
