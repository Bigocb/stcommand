/**
 * The shared "what is this ship doing right now" concept trader.ts/agent.ts/
 * scout.ts/siphoner.ts never had — each agent class privately knew its own
 * control flow, but nothing exposed it. `AgentStep` is that exposure: every
 * agent class holds one `currentStep` field, set at the same few real
 * moments (a navigation call, a buy/sell/extract/siphon API call) that
 * already existed in each class's trading/mining logic, and reset back to
 * `idle` immediately after. `FleetManager.syncShipStates()` reads it via
 * each agent's `getStep()` to populate `ship_state`'s `step` column for
 * real, and to report the design doc's `transacting` lifecycle state
 * instead of deriving state purely from nav status.
 *
 * Deliberately narrow: this instruments the money-moving/extraction calls
 * and the one shared navigation entry point per class, not literally every
 * API call each agent makes (dock/orbit/chart/refuel-check are not
 * "steps" in the sense the design doc means). No trading/mining logic
 * changes anywhere this is used — every call site is a pure side-effect
 * assignment bracketing an `await` that was already there.
 */
export type AgentStep =
  | { kind: "idle" }
  | { kind: "navigating"; to: string }
  | { kind: "transacting"; action: "buy" | "sell" | "refuel" | "extract" | "siphon" | "survey" | "jettison"; good?: string };

export const IDLE_STEP: AgentStep = { kind: "idle" };
