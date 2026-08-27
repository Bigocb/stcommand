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

/**
 * A control-flow signal, not a real error (deliberately does NOT extend
 * `Error`, so no generic `err instanceof Error` / message-sniffing catch
 * anywhere in an agent's call chain can mistake it for one — see
 * docs/eta-scheduled-ship-waits.md for the full design).
 *
 * Thrown by `waitForArrival()` (and, in agent.ts/scout.ts/siphoner.ts,
 * `navigateTo()`'s own duplicate inline wait — see each file's comment on
 * why those aren't unified with `waitForArrival()` here) instead of
 * blocking, but only while that agent's `schedulerDriven` flag is set —
 * true only for the exact duration of a `nextTask()`-family `run()`
 * closure's call into `tick()`/`surveyScout()`/`tourScout()`/`keeperPoll()`,
 * never during a manual `dispatchTo()`/`suspend()`-adjacent call, which must
 * keep blocking exactly as before (a manual dispatch is not scheduler-
 * driven work with a `Task` to reschedule).
 *
 * `resumeAt` is the real arrival time (ms since epoch) reported by the
 * game's own `nav.route.arrival` — not a guessed backoff. The catching
 * `nextTask()`-family method reschedules its own chain for exactly then,
 * instead of the tick that issued the navigate call blocking until it
 * happens (which, before this, meant one ship's transit could block
 * `Scheduler.runOnce()`'s strictly sequential loop from reaching any other
 * ready task — including the priority-0 rescue task — for the whole wait;
 * see docs/eta-scheduled-ship-waits.md §1).
 *
 * Every `catch` block sitting between a `navigateTo()`/`waitForArrival()`
 * call site and its owning `nextTask()`-family method's own top-level catch
 * must let an instance of this propagate untouched. Confirmed safe by
 * construction almost everywhere in this codebase already: every agent
 * class issues a navigate call *before* entering any narrower `try/catch`
 * that only wraps the specific transaction call after it (buy/sell/
 * transfer/deliver), so this simply never reaches those catches. The one
 * confirmed exception was `SiphonerAgent.navigateTo()`, whose own catch
 * unconditionally converted any thrown error into `return false` — fixed
 * there with an explicit re-throw guard.
 */
export class NavigationPending {
  constructor(readonly resumeAt: number) {}
}
