# Ship control state — audit and refactor scope

A code review of how ship ownership/control is represented, why the same class
of bug keeps recurring, and what to do about it.

**Short version:** the problem is real, it's already been diagnosed and designed
against in `startraders/docs/greenfield-design.md`, and the fix is half-built and
sitting dormant in this repo. The remaining work is a deliberately-deferred
migration stage, not a rewrite.

---

## 1. What triggered this

Two bugs fixed on 2026-08-21, hours apart, both reported as "a ship is stuck and
I didn't touch it":

- Ships stuck in **manual hold** after mission-carrier duty ended
  (`resumeAgent()` cleared suspension but not the manual-dispatch goal).
- A ship stuck **suspended and reporting "stranded"** after rescue-tender duty
  (`tenderRescueStep()` looked the tender up in 2 of 6 role maps, so a ship
  reassigned mid-rescue was never found or resumed — its cached fuel read 68u
  against a real 80u, because a suspended agent's `tick()` returns before it
  refreshes state or runs the stranded-flag auto-clear).

Both are the same defect wearing different clothes: **a subsystem borrowed a
ship, and handed back only part of what it took.**

---

## 2. What control state actually exists

Eight independent mechanisms can direct a ship. Six are per-ship mutable state:

| # | Mechanism | Lives in | Shape |
|---|---|---|---|
| 1 | Role maps | `fleet.ts` | 8 separate `Map`s (miners, traders, surveyors, tours, keepers, scouts, siphoners, idleShips) |
| 2 | Operator hold / dispatch | agent instance | `manualGoal` (`agent.ts`) / `manualWaypoint` (`trader.ts`) |
| 3 | Suspension | agent instance | `suspended` boolean |
| 4 | Route assignment | `RouteDispatcher` | `assignments` + a *separate* `manual` map |
| 5 | Warehouse ship | `fleet.ts` | single `warehouseShip` field |
| 6 | Mission carrier | `MissionManager` | `assignedShip` per mission |
| 7 | Keeper station | `fleet.ts` | `keeperMarkets` map |
| 8 | Mining pin | agent instance | `pinnedMiningTarget` |

Note that "manual" means three unrelated things across #2, #4, and #8 — an
operator hold, a trade-route override, and a mining-field override. They are
independently settable and independently cleared.

### The three availability checks

"Is this ship free?" is answered three different ways, none of them shared:

```ts
// dispatcherTraders()      — fleet.ts:584
.filter(([, a]) => !a.isManual() && !a.isSuspended())   // + not the warehouse ship

// pickMissionCarrier()     — fleet.ts:1868
!a.isManual() && !a.isSuspended()                        // + registry check, but only vs "operator"

// maybeAssignKeepers()     — fleet.ts:3047
!a.isManual() && !a.isSuspended() && cargo === 0 && role !== "COMMAND"
```

All three treat `isManual()`/`isSuspended()` as ground truth. Each adds its own
extra conditions. Nothing reconciles them.

---

## 3. The four bugs this produces

Two are fixed; two are live and unfixed as of this audit.

### A. Partial handback — mission carrier *(fixed 9048ad0)*
`resumeAgent()` called `resume()` but not `release()`. A carrier routed around
by `dispatchShip()` kept its manual-dispatch goal forever after the mission let
it go.

### B. Partial lookup — rescue tender *(fixed b7b6d31)*
`tenderRescueStep()`'s two resume paths looked in `this.miners`/`this.traders`
only. A ship reassigned to another role map mid-rescue was resumed by neither.

### C. Paused missions leak their carrier — **LIVE, UNFIXED**

`MissionManager.pause()` resumes the carrier but never clears
`mission.assignedShip`, and leaves the mission in `this.active`. Verified
empirically:

```
resumed:                    [ 'SHIP-1' ]     <- correctly handed back
committedShips() after pause: [ 'SHIP-1' ]   <- still committed, forever
```

Consequence chain:

1. `committedShips()` keeps reporting the ship.
2. `syncShipClaims()` therefore re-claims it as `owner: "mission"` every tick,
   with `preempt: true`.
3. `ShipRegistry` precedence is `operator(0) > mission(1) > warehouse(2) >
   keeper(3) > auto(4)`, and `claim()` rejects when the new owner is weaker.
4. So `designateWarehouseShip()` on that ship throws
   `"can't be designated warehouse ship — currently claimed by mission"`.

**A ship that was ever a carrier for a since-paused mission can never be made
the warehouse ship again.** This survives restart: `startConstruction()`'s
restore path rebuilds the mission with `assignedShip` intact and, when paused,
returns early without ever clearing it.

### D. Role changes silently drop control state — **LIVE, UNFIXED**

`clearRoleMaps()` calls `.stop()` and `.delete()` on the old agent;
`installRoleAgent()` constructs a **brand new** `ShipAgent`/`TraderAgent`. The
new instance starts with `suspended = false`, `manualGoal = null`.

So changing a suspended ship's role — via `setShipRole()`, or either
auto-promotion path in `init()` — silently discards its suspension. The ship
resumes acting autonomously while a mission or rescue is still driving it
through raw API calls. That is precisely the race `suspend()` exists to prevent;
its own doc comment describes the symptom ("not currently docked" errors).

---

## 4. This was already diagnosed

`startraders/docs/greenfield-design.md` §1 opens with the same table of eight
mechanisms and this conclusion:

> These are not independent defects to be fixed one at a time. They are the same
> defect — **no single source of truth for who controls a ship and why** —
> showing up in four places.

Its Pillar 1 designs `ShipRegistry` as the arbiter. **That class exists in this
repo** (`src/engine/shipRegistry.ts`, 104 lines, with precedence, compare-and-swap
`claim()`, owner-scoped `release()`, and persistence).

It is wired up as a **mirror, not a gate.** `syncShipClaims()` derives each
ship's owner *from* the old mechanisms once per tick and writes it into the
registry. Nothing consults the registry before acting, except two bolt-on
defensive checks (`pickMissionCarrier` vs `operator` only, `maybeAssignKeepers`
as "defense-in-depth", per their own comments). The class doc says this
plainly — dual-write was deliberate, and the cutover was scoped as later work.

`greenfield-migration.md` §4 is that deferred work, "Stage 2 — Registry becomes
authoritative," and it predicts the payoff:

> Replace availability logic with `registry.available(owner)` in the three
> places that each currently do it differently […] **This alone fixes A5** —
> the suspended/held-trader route lockout — because there is now one filter
> instead of three partial ones.

The design is done. The scaffolding is built and has been running in parallel
long enough to trust. What's missing is the switch.

---

## 5. Recommendation: finish Stage 2, don't rewrite

A parallel from-scratch project would mean re-deriving rate-limit handling,
contract feasibility scoring, warehouse cost-basis math, rescue tender
planning, mission supply chains, and doctrine — all of which work — to fix one
bad state model. And a rewrite that doesn't *specifically* attack this pattern
just carries it forward, because it's easy to reproduce by accident.

Stage 2 is bounded: it touches ownership decisions only, and leaves strategy,
routing, and the HTTP contract untouched.

### Scope

**Phase 0 — fix the two live bugs first (small, independently shippable)**
- `MissionManager.pause()`: clear `assignedShip` (or exclude paused missions
  from `committedShips()`). Add a test asserting a paused mission holds no
  carrier.
- Preserve control state across role changes: carry `suspended` / `manualGoal`
  onto the new agent in `installRoleAgent()`, or refuse a role change on a
  suspended ship. Add a test.

These are worth doing on their own even if Stage 2 never happens.

**Phase 1 — one availability function**
- Add `FleetManager.availableFor(owner)`, backed by `registry.available()`.
- Replace all three call sites (`dispatcherTraders`, `pickMissionCarrier`,
  `maybeAssignKeepers`), keeping their genuinely-role-specific extra filters
  (cargo empty, not COMMAND, reachability) as *additional* predicates layered on
  the shared availability answer, not as parallel definitions of it.
- Parity-check: log any disagreement between old and new answers for a tick or
  two before deleting the old paths.

**Phase 2 — claims become the gate**
- `MissionManager`, keeper stationing, and rescue-tender selection claim through
  the registry and fail gracefully when refused, instead of setting their own
  field + calling `suspend()`.
- `syncShipClaims()` stops being a mirror: it reconciles drift and warns, rather
  than blindly overwriting with `preempt: true`.

**Phase 3 — one handback path**
- A single `releaseTo(shipSymbol, owner)` that clears suspension, manual goal,
  dispatcher reservation, and the registry claim together. Every borrower calls
  exactly this. `resumeAgent()`, `releaseShip()`, `releaseCarrier()`, and both
  `tenderRescueStep()` paths collapse into it.
- This is the phase that makes bugs A–D structurally impossible rather than
  individually fixed.

**Phase 4 — collapse the flags (optional)**
Replace `suspended` + `manualGoal` with one derived read off the claim. Only
worth doing once Phase 3 has settled; the flags are harmless as private loop
state once nothing reads them for ownership.

### Not in scope
Role maps stay (Stage 5 territory). Dispatcher's internal `assignments`/`manual`
split stays. No `/api/*` shape changes. No strategy or pricing changes.

### Risk
Phases 0 and 1 are low risk and independently revertible. Phase 2 is the real
surgery — keep it one commit, per the migration doc's own advice. The 100-tick
integration test (`tests/integration.test.ts`) is the safety net that already
caught one preempt-ordering bug in `syncShipClaims`; it should be extended with
invariant assertions before Phase 2, not after.

---

## 6. Answering "should we start over?"

No — but the instinct is right, and it's pointing at something real and
already-documented. The engine's *strategy* code is fine. Its *ownership* model
is the recurring defect, it was correctly identified a design-cycle ago, the
replacement is built, and it's been running in shadow mode this whole time
waiting for someone to throw the switch.

Finishing Stage 2 is the version of "start over" that keeps everything that
works.
