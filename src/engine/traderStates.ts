/**
 * What each trader is doing at a dispatch recompute, in words that mean something.
 *
 * The dispatcher used to count a trader as "idle" whenever its hold was empty. A ship flying empty to the market it
 * has been assigned to buy at has an empty hold too, so on 2026-10-23 the log read "16 idle" of 24 with every one of
 * the 24 holding an assignment. The split here separates the cases an operator cares about:
 *
 *   carrying  cargo aboard (busy): on its way to sell
 *   en route  empty hold but assigned: flying to, or buying at, its next market
 *   waiting   empty hold and nothing assigned: the only ones with no work
 *   manual    held by an operator override
 *
 * Pure: the caller passes what it already knows.
 */

export type TraderState = "carrying" | "en route" | "waiting" | "manual";

export interface TraderStateInput { shipSymbol: string; busy?: boolean }

export function classifyTrader(t: TraderStateInput, hasAssignment: boolean, isManual: boolean): TraderState {
  if (isManual) return "manual";
  if (t.busy) return "carrying";
  return hasAssignment ? "en route" : "waiting";
}

export interface TraderStateSummary {
  carrying: number;
  enRoute: number;
  waiting: number;
  manual: number;
  /** Ships with an empty hold and no assignment, named so the cause can be looked at. */
  waitingShips: string[];
}

export function summarizeTraderStates(
  traders: readonly TraderStateInput[],
  assigned: ReadonlySet<string>,
  manual: ReadonlySet<string>,
): TraderStateSummary {
  const out: TraderStateSummary = { carrying: 0, enRoute: 0, waiting: 0, manual: 0, waitingShips: [] };
  for (const t of traders) {
    const s = classifyTrader(t, assigned.has(t.shipSymbol), manual.has(t.shipSymbol));
    if (s === "carrying") out.carrying++;
    else if (s === "en route") out.enRoute++;
    else if (s === "manual") out.manual++;
    else { out.waiting++; out.waitingShips.push(t.shipSymbol); }
  }
  return out;
}

/** "24 traders (carrying 9, en route 13, waiting 2 [A, B], manual 0)": the head of the dispatch recompute line. */
export function formatTraderStates(total: number, s: TraderStateSummary, nameLimit = 6): string {
  const names = s.waitingShips.length ? ` [${s.waitingShips.slice(0, nameLimit).join(", ")}${s.waitingShips.length > nameLimit ? ", …" : ""}]` : "";
  return `${total} traders (carrying ${s.carrying}, en route ${s.enRoute}, waiting ${s.waiting}${names}, manual ${s.manual})`;
}
