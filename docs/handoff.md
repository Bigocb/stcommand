# Handoff — the subsystem verification pass

For whoever picks this up cold. Written at commit `f4e8329`, immediately
after step 4 of the control-plane migration was closed and pushed, and
updated once its live prediction had been checked (it missed — §6).

**The next piece of work is migration step 5**, and it is not blocked on
anything. Skip to §6 if you want the job; read §4 first if you want to know
the standard it has to be done to.

The previous handoff (the parallel-UI work, `v3`/`v4`/`v5`) is finished and
archived at `docs/handoff-ui-versions.md`. It is history, not instructions.

Read in this order:

1. this file — state, method, and the traps;
2. `CONTEXT.md` — the standing orders (language, tenancy, ownership,
   scheduling, migration discipline). Non-negotiable house rules;
3. `docs/control-plane-data-plane.md` — the design and the six-step
   migration, §8 being the live scoreboard;
4. `docs/subsystem-verification.md` — the evidence file: what was broken,
   what changed, what proof exists;
5. `docs/bug-log.md` — open items only, each mapped to a migration step.

---

## 1. The one-paragraph state of the world

`stcommand` is a multi-tenant SpaceTraders fleet-automation service running
on Render, one process with a `TenantWorker` per tenant, deployed from `main`
on every push. It is mid-way through a migration from "controllers fly ships"
to a Kubernetes-shaped control plane / data plane split. Five of the six
migration steps are done; step 5 (controllers) is half-done. Layered on top of
the migration is a **verification pass**, requested by the user, in which each
subsystem is made to work *and shown to work* under a stated standard. Eight
verification steps have landed. Five are verified against production; three
are proven by tests only, because production has not yet produced the
conditions that exercise them.

---

## 2. Exactly where you are standing

| | |
|---|---|
| Branch | `main`. Pushes to `main` **auto-deploy to the live fleet.** This is explicitly authorized. |
| HEAD | `f4e8329` "Stop treating a dispatch as a claim on the hull" |
| Working tree | clean as of the commit; `docs/handoff.md` (this file) and the rename of the old one are the only pending changes |
| Render service | `stcommand`, `srv-da0veurl550s73eg2sog`, workspace `tea-d78npo450q8c73f2n45g`, region oregon, url https://stcommand.onrender.com |
| Deploy of `f4e8329` | live at 23:21:55. Its prediction was checked at 23:29 and **missed** — untested rather than refuted, see §6 |
| Typecheck | clean |
| Tests | 266 pass across every non-DB file. The 4 failures are `ECONNREFUSED` in the DB-backed `agentStep.test.ts` — see §9 |

There are ten stale `claude/*` branches on the remote from earlier sessions.
Ignore them; none are in play.

---

## 3. The frame the user set — do not re-litigate these

Quoted, because the wording matters:

- **"we are going to ensure each step is functioning completely with proof,
  we will be methodical"**
- **"I want to make sure the mechanics of each subsystem work perfectly...
  This is the pass where we start turning this into a real thing."**
- On money: **"That's fine. I'm not worried about profitability right now"**
  and, later, **"we will deal with profitability, right I mean and that's
  where the doctrine rules help. But I just mean for right now let's get the
  mechanics right and then worry about profitability."** Profitability is
  **deferred, not abandoned**, and its home is doctrine.
- **"I want you to write documentation for each of these steps."** Hence
  `subsystem-verification.md`. Keep writing it; it is a deliverable, not a
  courtesy.
- On scope: **"Before you're adding more rules, don't you think we should
  finish the implementation"**, then **"And which overarching step in the
  implementation do these fit in."** This is why every entry in
  `bug-log.md` names its migration step. A fresh agent will feel the same
  pull toward adding policy instead of finishing structure. Resist it: sort
  new findings into *finishing a step* vs *new doctrine*, and say which.

**Standing goals**, carried from earlier sessions: in-system and cross-system
trading working flawlessly; maximise exploration to find new markets and
pricing; maximise profit; **never let a ship reach zero condition**.

**Working agreements learned the hard way:**

- **Batch documentation commits with code.** Every push redeploys the engine
  and opens a ~60-second window where two processes tick the same fleet
  (bug-log #3). A doc-only commit pays that cost for nothing — including,
  once, the commit that was *recording the overlap bug*.
- The user is frequently **on mobile**. Keep answers scannable; expect the UI
  to be judged on a phone.
- The user runs experiments on the live fleet (switching a ship's role by
  hand, pressing Hold). Ask before assuming an anomaly is a code defect —
  more than once it was them.

---

## 4. The method — this is the actual deliverable

`docs/subsystem-verification.md` §"The standard". A step is **verified** only
when all four hold; anything less is recorded as partial with the gap named:

1. **The defect is stated as a mechanism, not a symptom.** "Sales stopped" is
   a symptom. "`pickSellTarget()` reads `inventory[0]`, so residue at the
   front of the hold hides sellable ore behind it" is a mechanism.
2. **Tests fail without the fix** — written, then checked by *stashing the
   source change* and re-running. A test that passes both ways proves nothing
   about the fix; it may still earn its place as a **control**, and is
   labelled as one.
3. **A prediction is made before the deploy**, in terms of log lines that will
   or will not appear.
4. **The prediction is checked against production, and reported whichever way
   it came out.**

This exists because absence of errors was repeatedly mistaken for function: a
fleet sat still for hours behind a log line reading `fleet paused`, and four
miners spun on a full hold for ninety-five minutes while scheduler
`failed=0`, tasks ran, and ships logged activity. **Absence of errors is not
evidence of function.** Record what was positively observed, and — just as
deliberately — what was not.

---

## 5. The architecture, in one screen

Full text in `docs/control-plane-data-plane.md`. The mapping:

| SpaceTraders | Kubernetes/Envoy |
|---|---|
| Ship | Pod |
| `ShipIntent` | Pod spec |
| `ShipProxy` | kubelet |
| controllers (`maybeRepairFleet()`, `maybeAssignKeepers()`, …) | Deployment controllers |
| `IntentBoard` | scheduler/arbiter |
| `Registry` | etcd + xDS |
| `intentVersion` | `observedGeneration` |

**The five rules** (the section heading still says "four" — rule 5 was added
later; fix the heading if it bothers you, it has misled no one yet):

1. **Controllers never call the kubelet.** Nothing above the executor awaits
   a ship. `tick()` flying a ship is the API server ssh'ing into a node.
2. **The kubelet never chooses a route.** A ship picks *endpoints* within
   policy (nearest healthy fuel, nearest yard, which gate); never *which good
   to trade* or *whether to explore*. Route = control plane; endpoint
   selection = data plane.
3. **Level-triggered, not edge-triggered.** Every controller is
   `reconcile(registry, spec) → intents`. There is no "after the navigate";
   there is only the next diff.
4. **Status is written by the thing that observed it.**
5. **A data-plane primitive either changes the world or raises.** No movement,
   dock or transaction may fail by logging and returning — to its caller that
   is indistinguishable from success, and the next statement then acts on the
   plan's world instead of the real one.

**Rule 5 is the one that keeps finding bugs.** Nearly every defect in this
pass is a silent fallback: a cost that reads as zero when unknown, a sell
that happens wherever the ship is rather than where the plan said, a
purchase that skips the balance the design nominated. When hunting, look for
`if (x) { … }` with no `else` that raises.

### The six steps (§8 of the design doc — keep this table honest)

| Step | State | Note |
|---|---|---|
| 1. Data plane cannot block | **Done** | no `await sleep(` in any agent; `CooldownPending`/`NavigationPending` yield the scheduler |
| 2. Registry by reference | **Done** | one `Registry`, read by reference |
| 3. One executor | **Done** | `ShipProxy` holds the primitives; the trader re-derives its trip each tick |
| 4. Intents + arbiter | **Done** (just now) | see §6 |
| 5. Controllers | **Half** | `autoExplore()`/`exploreSystem()` and the rescue tender still fly ships from inside controllers — **this is all that is left of the migration** |
| 6. Telemetry | **Done** | `getStep()`/`stepFor()` feed `getShipStatuses()` |

§8 previously read "all six steps built". That was wrong, and the error was
load-bearing: step 3 was marked complete when half of it was done, and every
bug found since lived in the half that was skipped. **Do not mark a step Done
to make the table look better.**

### The intent board, concretely

- `propose()` is per-tick and ephemeral; `commit()` resolves to **one intent
  per ship** by priority: `0 rescue · 1 repair · 2 earn · 3 explore/upkeep ·
  4 idle`. Ties go to the **first proposal**.
- `supersedes(intent, current)` reads `version`, so a hull mid-task can tell
  its goal was replaced.
- `drivenByFleet(goal)` (`src/engine/intent.ts:128`) decides whether an agent
  **stands down** or **executes**. It is now down to
  `goal.kind === "hold" && goal.waypoint === undefined`, `tender`, and
  `explore`. When the executor learns to fly an explore goal, that line
  changes again and **step 5 is finished**.
- Ownership precedence (ADR-0006, `ShipRegistry` as sole arbiter):
  `operator > rescue > mission > warehouse > keeper > auto`.
- `NavigationPending` / `CooldownPending` are **control-flow signals, not
  `Error` subclasses**. Do not catch them as errors.

---

## 6. What just landed, and the very next thing to do

**Step 4 — one owner per hull.** Two commits:

`ea6b622` *Make an operator hold an intent the ship flies.* `holdShip()` used
to call `agent.dispatchTo()`, which flew the hull *from inside the fleet*
(rule 1) and set a private `manualGoal` field — a second record of who owned
the ship. `isManual()` answered from the agent while the arbiter answered
from the board, so they could disagree, and did: an operator pressed Hold,
watched the sheet keep saying "Under doctrine", and concluded the button was
broken, while the engine log said `manual hold`.

A hold now splits on whether it names a waypoint. **With** one it is an
operator parking a hull, flown by the ship through
`ShipProxy.runHoldGoal()` (`src/engine/shipProxy.ts:419`) with position
re-derived each tick — so a hold placed on a moving ship completes on
arrival. **Without** one it is still the arbiter saying "nothing worth
doing"; there is nowhere to fly, so standing down *is* executing it, and it
stays in `drivenByFleet()`. `holdShip()` only persists now;
`proposeOperatorHolds()` (`fleet.ts:4135`) re-proposes every tick from an
in-memory mirror, level-triggered, and **runs first in `tick()`
(`fleet.ts:3975`) so its priority-0 tie beats rescue's own priority-0 hold**,
matching ADR-0006's precedence.

`f4e8329` *Stop treating a dispatch as a claim on the hull.* The insight that
made this small: of the ten callers of `dispatchShip()`, **nine are internal
errands** — reach a jump gate, get to a yard to buy, station a keeper — that
only ever wanted the hull to *move*. Exactly one, the dashboard's "Send to
waypoint", wanted it to stay. The side effect was a latent bug the codebase
already carried a scar for: `exploreSystem()` wraps its trip in a
`try/finally` that releases the ship purely to undo a hold nobody asked for.

So `dispatchTo()` is a movement primitive in `ShipAgent`, `TraderAgent` and
`SiphonerAgent`; `manualGoal`/`manualWaypoint`/`isManual()` are gone from all
three. **`ScoutAgent` keeps its `manualGoal` deliberately** — there it means
"chart *this* target next", an override of *what to do* like `mineAt()`, not
a claim on the hull. Do not "finish the cleanup" by deleting it. The one
caller that wants the ship to stay says so: `sendShipTo()` (`fleet.ts:2922`)
places the hold, then moves. The four availability checks now ask
`FleetManager.isHeld()` (`fleet.ts:490`), and **`isManual()` no longer exists
on the `ControlledAgent` interface**, so the original disagreement is not
merely fixed but *unrepresentable*.

### The prediction that was outstanding — now checked, and it missed

*(Kept in full because how it was checked is the point, not just the result.)*

**Checked the prediction written before the deploy**, recorded in
`subsystem-verification.md` under "Proof of the closing half":

> `dispatch → WP` replaces `manual dispatch → WP` in the logs. A ship sent on
> an internal errand (a scout reaching its gate, a hull going to a yard to
> buy) is picked for automatic work again afterwards rather than sitting
> benched. "Send to waypoint" still parks the ship, now reported as
> `operator hold at WP`.

How to check (Render MCP tools; `list_workspaces` first if no workspace is
selected — **do not pick a workspace yourself**):

```
mcp__Render__list_deploys  serviceId=srv-da0veurl550s73eg2sog   # wait for status "live"
mcp__Render__list_logs     resource=["srv-da0veurl550s73eg2sog"]
                           text=["manual dispatch"]   # expect NONE after the deploy
                           text=["dispatch →"]        # expect these instead
                           text=["operator hold"]
```

Then **write the result into `subsystem-verification.md`, whichever way it
came out**, replacing `**Live:** _pending._`, and update the Queue row for
step 8. Reporting a failed prediction is the point of the standard; a
prediction quietly dropped is worse than one that was wrong.

**Result, recorded 23:29 — the prediction is untested, not confirmed.** Zero
`manual dispatch → WP` lines in the 68 minutes spanning the deploy, and zero
`dispatch → WP` lines either: every "dispatch" hit is the dispatcher's
periodic `dispatch recompute:` heartbeat. No dispatch of either kind
occurred, so the old line's absence says nothing — a working fix and a dead
code path look identical from outside. Step 8 joins 4 and 5 in §7. The same
window did positively confirm step 3's named reason in production and the
deploy double-tick (twice, across two deploys, three instances).

---

### → THE IMMEDIATE NEXT ACTION: finish migration step 5

**This is the work. It does not wait on anything.**

Step 5 is the last unfinished step of the migration, and it is two
controllers: `autoExplore()` / `exploreSystem()`, and the rescue tender.
Both still fly hulls from inside the controller, which is rule 1 broken in
exactly the way `runCriticalRepair()` broke it before repair became a goal.

You have two worked examples to copy, and they are the whole pattern:

- **repair** — `maybeRepairFleet()` proposes and releases; the hull flies
  itself through `ShipProxy.runRepairGoal()`.
- **the trader** — each entry re-derives the trip from the hold and the
  ship's observed position, rather than running straight through.

The finish line is legible in one line of code: when the executor can fly an
explore goal, `explore` comes out of `drivenByFleet()`
(`src/engine/intent.ts:128`) and step 5 is done. That function is currently
`hold`-without-waypoint, `tender`, and `explore`. Getting it to
`hold`-without-waypoint alone is the goal.

Do this under the §4 standard like every step before it: state the defect as
a mechanism, write tests that fail with the source stashed, **write the
prediction down before deploying**, then check it and report it either way.

---

## 7. What is NOT verified live, and why it matters

| Verification step | Status | Why not |
|---|---|---|
| 4 — repair as a goal the ship flies | tests only | no hull has taken damage since the deploy |
| 5 — trader re-derives its trip | tests only | the trader has not completed a trade since the deploy |
| 8 — operator hold as an intent | tests only | **nobody has pressed Hold, and no ship has been dispatched, since the deploy** |

This is a pattern worth naming rather than a coincidence: **the paths hardest
to verify are exactly the ones that only fire under conditions production has
not produced.** One click of Hold from the user settles the third in seconds
— it is fair to ask for it. The user has **parked an alternative approach for
discussion** ("Maybe there is an alternative, we can discuss later") — likely
some form of deliberately provoking these conditions, or a staging tenant.
That conversation is open and unresolved; raise it, don't invent a design and
ship it.

---

## 8. Open items (`docs/bug-log.md`, kept in sync)

| # | Item | Belongs to |
|---|---|---|
| 1 | **Contract acceptance can take a guaranteed loss.** Confirmed with numbers: contract `cmtq3cdo` needs 22u DRUGS at ~11,300c ≈ 248,700c to fulfil, against a payout of 181,474c — a **~67,000c guaranteed loss**, accepted at 17:33 and worked for four hours because deliveries were silent. Two independent defects in `acceptBest()` (`contract.ts:140`), either sufficient alone: (a) **unknown sourcing cost is treated as free** — `if (cheapest) sourcingCost += …`, so with no market snapshots the score is raw payout; (b) **no sign check** — the least-bad contract is accepted however negative. | **rule 5** for the silent zero; **doctrine** for the margin gate. The margin belongs in doctrine, not a hardcoded `> 0`. |
| 2 | **No way to abandon a contract.** Constraint to know before designing: the API has `accept`/`deliver`/`fulfill`/`negotiate` and **no cancel**. So "abandon" can only mean *stop working it* — release the trader, drop the `contractBuy` assignment, let it lapse, and say so honestly in the UI with the reputation cost stated. Cheaper now: the operator hold is an intent, so "stop working this contract" is the same shape and needs no new ownership channel. | **step 4** shape |
| 3 | **Two processes tick the same fleet during a deploy.** ~60s per deploy where old and new instances both run a `TenantWorker` against the same hulls; `shutting down` never appears in the logs. Fix shape: a **per-tenant Postgres advisory lock**. | infrastructure |
| 5 | **A trader stays assigned to work it cannot fund.** Observed live: `cannot afford one unit at 11350c with 0c in hand; trading instead`, while `dispatch recompute` re-assigns `DRUGS:contractBuy` every minute for 38 minutes straight. The dispatcher scores the assignment at its payout with no affordability gate, so the trader oscillates between two waypoints discovering prices it will never act on. Step 3's fix made the loop *legible*; it cannot shed the assignment. | **doctrine** — belongs beside item 1's margin gate |
| 7 | **A ship purchase left the fleet under the floor too — unexplained.** At 17:34 the fleet bought `SHIP_MINING_DRONE` for 48,328c and came out at 5,929c, below the 20,000c floor, on the *ship* path — which already went through `canAfford()`, unlike the trader path item 5's fix repaired. The pre-purchase balance is unknown, so this is **flagged, not claimed**. It is the second purchase to leave the fleet underwater and deserves a check before the trader is assumed to have been the only leak. | **step 2** if real — a call site reading around the single source of truth |
| 6 | **"0c in hand" is not the balance.** The affordability message prints `spendableNow()`, i.e. `max(0, credits - cashFloor)`. `0c in hand` means "nothing above the 20,000c floor", not "broke". A number that does not mean what its words say. | **rule 5** family |
| 4 | **Live UI updates (SSE).** Wanted, not a bug. Today: 5s polling, four endpoints per client, `setInterval` — which is what mobile browsers throttle hardest. **Wants the advisory lock (3) first**, or a client pins to a draining process. | step 6 family |

Also queued: **`priceTable` → registry** (single source of truth for prices),
multi-hop routing, jump-gate construction status. The Queue table at the foot
of `subsystem-verification.md` has **duplicated row numbers (9, 7, 8, 9)** —
harmless, but fix it while you are there.

**Ordering principle**, stated in that file and worth keeping: *do the
loud-failure work before the structural work*, so that when a refactor breaks
something it screams instead of silently mis-trading.

### The money situation, so you don't misread it as I did

At the time of writing the fleet holds **~8,000c against a 20,000c cash
floor** — under it, so nothing non-fuel is spendable and the logs print
`0c in hand`. **This is a recovering system, not a stuck one.** The hole was
dug at 22:02 by the pre-fix trader (10,336c → 1,407c on one DRUGS buy); the
cash-floor fix landed at 22:24; the balance has climbed monotonically since,
with no purchases at all:

```
22:02  1,407c   ← the DRUGS buy
22:24  2,690c   ← cash-floor fix deploys
23:02  6,032c
23:21  7,319c
23:31  7,973c    ≈ +4,700c/hr — clears the floor in ~2.5h
```

I read one window of this and called the fleet stuck. It is not. The fix
works; the hole simply predates it. **Balances from the `booting DRAGOM @ …,
N credits` boot lines are the ground truth** — the 15-minute `earnings`
windows disagreed with them and the balances were right.

Two consequences while it is underwater, worth knowing rather than acting on:
repair is gated by the same floor (`fleet.ts:2230`), which collides with the
standing "never let a ship reach zero condition" goal; and the trader cannot
fund its contract assignment (item 5).

**None of this blocks the engineering.** Step 5 does not touch money.

---

## 9. Environment, tests, and hard constraints

```bash
npm run typecheck          # tsc --noEmit
npm test                   # node --test, all tests, needs a DB for some
npx tsx --test tests/foo.test.ts   # a single file, no DB needed for most
npm run migrate:test       # applies migrations to the test schema
```

- **The DB-backed suite cannot run from a cloud session.** There is **no
  egress to Postgres on 5432 from this container at all** — `ETIMEDOUT`,
  independent of credentials. This was initially misdiagnosed as a scram-auth
  problem; it is not. Check egress before blaming credentials. Every run in
  the verification doc is therefore the **non-DB subset**, and each failure is
  classified individually rather than waved at — so far all
  `ECONNREFUSED`/`SASL` on Postgres.
- **`.env.test` is gitignored and must never be committed.** It holds a
  Postgres URL the user pasted into a transcript; **that credential should be
  rotated.** Never echo it, commit it, or send it anywhere.
- **`DB_SCHEMA` must never be `stcommand`** (the production schema) when
  running tests: `store.test.ts` and `tenantRegistry.test.ts` run
  `DELETE FROM tenants`. `scripts/assert-test-schema.mjs` enforces this as
  npm `pretest`. Do not bypass it.
- The database (`promptoria_db`) is **shared with an unrelated app in
  `public`**, which is why `search_path` is pinned at the pool level.
- Postgres uses **FORCE RLS**. An RLS false negative has already caused two
  wrong diagnoses (commit `c4cd309`).
- `.claude/settings.json` pre-approves `npm run migrate:test` and
  `node --test:*` so those do not prompt.
- SpaceTraders API facts that have bitten: the **rate limit is per-IP and
  shared across tenants**; `getMarket` returns prices **only when docked**;
  jumps are **gate→gate, single hop**.

---

## 10. Traps — mistakes actually made here, so you don't repeat them

Read this section. Most of it is epistemics, not code.

- **Reading one short window and reporting a transient as steady state.** I
  read a 15-minute window minutes after a deploy — dominated by repositioning
  fuel cost — and declared the mine→sell loop unprofitable. It wasn't.
- **Declaring a subsystem idle without checking the whole record.** I said the
  fleet "has never traded" having queried only from 18:34; it had traded
  17:44–18:09. The user's push-back — *"I think it's assigned a contract which
  it's supposed to be filling"* — is what led directly to finding the silent
  contract deliveries.
- **Books that omit a revenue stream.** `ledgerSummary()` did not count
  contract payouts, so `net` was wrong. It now includes `contract`:
  `net = sells + contract - purchases - refuel - ship`.
- **Blaming the interesting suspect.** A missing Release button "must" be the
  two-instance overlap; it wasn't — only one instance was logging. The real
  cause was the ship sheet not being subscribed to the store. When the user
  asked *"Is it due to your jettison logic"*, the right move was to actually
  check (wrong class, protected goods excluded, timing 2.5h before deploy, no
  jettison line) rather than assert innocence.
- **A fix that reproduces the disease it treats.** In `runContractBuy()`'s
  exits I inferred "contract needs no more" from `cap <= 0` — which misfires
  when a *full hold* zeroed it. That is the same silent-wrong-answer shape the
  fix existed to remove. Hoisting `stillNeeded` as its own variable fixed it.
  Watch for this: the code you write to make a failure legible can itself lie.
- **Bending tests back to the old contract.** Two tests asserted the pre-step-4
  behaviour (`fleetStatusSummary` sourcing `manual hold` from the agent flag;
  `intentConsumption` expecting a hold-with-waypoint to stand down). They were
  **rewritten to the new contract**, deliberately — but always ask which of
  the two is wrong before touching either.
- **Doc-only commits cost a double-tick window.** See §3.

---

## 11. File map for the parts in play

| Path | What lives there |
|---|---|
| `src/engine/fleet.ts` | `FleetManager` — the control plane. `operatorHolds` map (:158), `isHeld()` (:490), `spendableCredits()` (:539), `sendShipTo()` (:2922), `dispatchShip()` (:2930), `holdShip()` (:2951), `updateShipManualState()` (:2985), `getShipStatuses()` (:3222+), `tick()` (:3975), `proposeOperatorHolds()` (:4135) |
| `src/engine/shipProxy.ts` | the executor/kubelet. `assertAt()` (:299), `runRepairGoal()` (:365), `runHoldGoal()` (:419) |
| `src/engine/intent.ts` | `ShipIntent`, `IntentBoard`, `supersedes()`, `drivenByFleet()` (:128) |
| `src/engine/shipRegistry.ts` | ADR-0006 ownership arbiter |
| `src/engine/agent.ts` / `trader.ts` / `siphoner.ts` / `scout.ts` | the four agent classes. `dispatchTo()` is movement-only in the first three; `scout.ts` keeps `manualGoal` on purpose |
| `src/engine/contract.ts` | `ContractManager`; `acceptBest()` (:140) is bug-log #1 |
| `src/engine/doctrine.ts` | policy — where profitability work belongs |
| `src/db/store.ts` | persistence, `ledgerSummary()` |
| `src/http/dashboard.ts` | dashboard API; "Send to waypoint" → `sendShipTo()` (~:834) |
| `src/http/gate.ts` | auth/session; `GET /session` returns `{ agentSymbol, onboardingPending }` |
| `public/v2..v5.*` + `public/shared/*.js` | the four parallel UIs and their shared modules |
| `tests/operatorHold.test.ts` | step 4/8 coverage — the one to extend |

---

## 12. If you do nothing else

1. **Finish migration step 5** (§6). It is the last unfinished step, it is two
   controllers, and it waits on nothing — not on credits, not on the user.
   The pattern to copy is repair and the trader.
2. Ask the user for one click on **Hold** to settle step 8 live, and raise the
   parked question of how to exercise repair and trading deliberately. Ask;
   don't block on it. Step 5 proceeds either way.
3. Keep the verification standard (§4) on every step: mechanism, tests that
   fail with the source stashed, a prediction written before the deploy, and
   the result reported whichever way it came out.
4. Keep profitability in doctrine, and keep the bug log mapped to steps.
