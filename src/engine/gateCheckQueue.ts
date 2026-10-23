/**
 * Which jump gates the galaxy crawler should ask the public /construction endpoint about next.
 *
 * A gate that has finished construction never goes back, so a gate known complete is never asked again. A gate never
 * checked comes first; one known unfinished is re-read only once its last check is older than `recheckMs` (an unfinished
 * gate changes only when someone supplies it), oldest first.
 *
 * Pure: the caller passes every known gate, what is already recorded, and the clock.
 */
export interface GateRef {
  systemSymbol: string;
  gateSymbol: string;
}

export interface KnownGate {
  isComplete: boolean;
  /** When the status was last read, ms; undefined when the store did not say. */
  checkedAtMs?: number;
}

export interface GateCheckPolicy {
  /** How long an unfinished gate is left before it is read again. */
  recheckMs: number;
}

export const DEFAULT_GATE_CHECK_POLICY: GateCheckPolicy = { recheckMs: 60 * 60_000 };

export function gatesToCheck(all: readonly GateRef[], known: ReadonlyMap<string, KnownGate>, now: number, policy: GateCheckPolicy = DEFAULT_GATE_CHECK_POLICY): GateRef[] {
  const fresh: GateRef[] = [];
  const stale: { gate: GateRef; at: number }[] = [];
  const seen = new Set<string>();
  for (const g of all) {
    if (seen.has(g.gateSymbol)) continue;
    seen.add(g.gateSymbol);
    const k = known.get(g.gateSymbol);
    if (!k) { fresh.push(g); continue; }
    if (k.isComplete) continue;
    const at = k.checkedAtMs ?? 0;
    if (now - at >= policy.recheckMs) stale.push({ gate: g, at });
  }
  stale.sort((a, b) => a.at - b.at);
  return [...fresh, ...stale.map((s) => s.gate)];
}
