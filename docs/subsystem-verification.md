# Subsystem verification pass

The pass where each subsystem is made to work correctly and *shown* to work,
one at a time. Not a refactor log and not a changelog: a record of what was
broken, what was changed, and what evidence exists that the change did what
it claims.

It exists because of how the previous stalls were found. A fleet sat still
for hours behind a log line reading `fleet paused`, and four miners spun on
a full hold for ninety-five minutes while every health signal — scheduler
`failed=0`, tasks running, ships logging activity — said the system was
fine. Absence of errors is not evidence of function. So this file records
what was positively observed, and, just as deliberately, what was not.

---

## The standard

A step is **verified** only when all four hold. Anything less is recorded as
partial, with the gap named.

1. **The defect is stated as a mechanism**, not a symptom. "Sales stopped"
   is a symptom. "`pickSellTarget()` reads `inventory[0]`, so residue at the
   front of the hold hides sellable ore behind it" is a mechanism.
2. **Tests fail without the fix.** Written, then checked by stashing the
   source change and re-running. A test that passes both ways proves
   nothing about the fix; it may still earn its place as a *control*, and is
   labelled as one.
3. **A prediction is made before the deploy**, in terms of log lines that
   will or will not appear. Reading the logs afterwards and assembling a
   story from whatever is there is how four wrong diagnoses got made in one
   evening.
4. **The prediction is checked against production**, and the result is
   reported whichever way it came out.

### On "no regressions"

The DB-backed suite cannot run from a cloud session — there is no route to
Postgres on 5432, independent of credentials (see the `.claude/settings.json`
commit). Every run below is therefore the non-DB subset. Where failures
appear, they are classified individually rather than waved at; so far every
one has been `ECONNREFUSED`/`SASL` on Postgres.

---

## Step 1 — Rule 5 at the remaining transaction sites

**Commit:** `de4fa90` · **Status:** verified

### Defect

`assertAt` — refuse to transact unless the ship is where the plan says —
was added to `trader.ts` after DAGGER-F spent twenty minutes buying and
selling at markets in systems it was not in, losing 9,036c a cycle. That
fixed one role and left three sites with identical exposure:

| Site | Shape |
|---|---|
| `ShipAgent.executeArbitrage()` | buy, navigate, sell, straight through — the same shape as `runArbitrage()` |
| `ShipAgent.sellAllCargo()` | called after a navigate whose return value the caller never inspects |
| `SiphonerAgent.sellAllCargo()` | same, one dock later |

The API will transact at whatever market the ship is actually docked at. A
miner whose trip to market silently failed sells its ore at the asteroid
field, and the log reports a sale at the target.

### Change

The check moved to `ShipProxy` and every role calls the same one. That is
where it belonged: the proxy is the only thing that knows where the ship
really is, so an agent asserting against its own cached `this.ship` would be
checking the plan against the plan. `trader.ts` keeps a one-line private
method so its six call sites read unchanged.

Both `sellAllCargo()` implementations now take the waypoint they are
supposed to be selling at. Rule 5 needs something to check against, and
"wherever we ended up" is the bug.

### Proof

- **Tests:** 6 new in `tests/transactWhereYouAre.test.ts`, 3 in
  `tests/shipProxy.test.ts`. **4 of 6 fail with the source stashed.** The
  other 2 are controls: a legitimate trip completes, and a ship docked at
  its own market still sells.
- **Live:** the first soak proved only the negative — zero `refusing to`
  lines, `failed=0`, no regressions. **The guarded paths never executed,**
  because the fleet was deadlocked (step 2) and made no sales at all. This
  was reported as unproven rather than counted as success.
- **Live, retroactively:** after step 2 unblocked selling, four sales ran
  through `sellAllCargo(expectedAt) → proxy.assertAt() → sold` at 20:04–20:06
  with no refusals. That is the positive evidence the first soak could not
  produce.

### Known gap

`SiphonerAgent.navigateTo()` catches non-`Pending` navigation failures,
logs, and returns `false` — a rule 5 violation at the wrapper level. Its one
caller checks the return, so it is currently handled. Left for the step-3
executor work, where that agent is restructured anyway; recorded rather than
silently passed over.

---

## Step 2 — The cargo-residue deadlock

**Commit:** `5d06da0` · **Status:** verified

### Defect

An asteroid yields what it yields. At `X1-S84-EC5D` that was iron, copper
and aluminium ore — all sellable at `X1-S84-H56` — mixed with quartz sand,
ice water and silicon crystals, none of which H56 lists. Tallied from the
extraction log: **33 of 69 units mined had no buyer there.**

`sellAllCargo()` catches each rejection and moves on:

```
DRAGOM-6: sell failed: Market sell failed. Trade good SILICON_CRYSTALS is not listed at market X1-S84-H56.
```

so the unsellable half stayed aboard after every trip. Visible in a single
trip as `selling 4 saleable cargo` followed by exactly **two** `sold` lines.

Two faults then compounded it:

- `pickSellTarget()` read `inventory[0]` and gave up if that one good had no
  buyer. Once residue reached the front of the hold, the ship stopped seeing
  the saleable ore behind it.
- Nothing disposed of cargo with no buyer. The trader has
  `clearLeftoverCargo()`; the miner had no equivalent, so a dead good held
  its slot permanently.

Sales decayed 12 → 9 → 5 → 1 → 0. The last extraction in the entire run was
17:57:55; four miners then sat at `c15/15` re-mining into a full hold every
eight seconds until 20:03.

### Change

`pickSellTarget()` ranks every unprotected good in the hold by proceeds
(price × units) and returns the best market for any of them.
`dumpUnsellableCargo()` jettisons goods no reachable market lists — but only
at ≥80% hold *and* only after `discoverMarkets()` has already failed, since
listings change and carrying a few units is free while there is room to
mine. Protected goods are never touched: a contract good having no market is
the normal case, and jettisoning it would destroy the delivery being paid
for.

### Proof

- **Tests:** 7 in `tests/minerCargoDeadlock.test.ts`. **6 fail with the
  source stashed.** The seventh is a control — a wholly unsellable hold
  correctly yields no target either way.
- **Prediction, made before deploy:** jettison lines → extractions resume →
  `sold` lines resume.
- **Live, in that order:**

```
20:03:24  DRAGOM-5: jettisoned 5u SILICON_CRYSTALS: no reachable market buys it
20:03:26  DRAGOM-5: jettisoned 9u ICE_WATER
20:03:28  DRAGOM-5: jettisoned 1u QUARTZ_SAND
          ... DRAGOM-4, DRAGOM-3, DRAGOM-6 likewise
20:04:29  DRAGOM-4: sold 1u ALUMINUM_ORE @ 73c
20:04:50  DRAGOM-6: sold 2u IRON_ORE @ 61c
20:06:14  DRAGOM-5: sold 3u COPPER_ORE @ 72c
```

  The jettisoned set is exactly the three goods H56 does not list; no ore was
  destroyed. 29 extractions between 20:07 and 20:16, against **zero in the
  preceding 2h05m**. At 20:16 a full hold *departs* (`DRAGOM-4 transit →
  X1-S84-H56 c15/15`) where before all four sat `in orbit c15/15`.

### Deliberately not fixed

The loop now runs at a loss: `sold +484 · fuel -792`. That is profitability,
not mechanics, and this pass is about mechanics. Recorded so it is not
mistaken for an oversight. ~40% of yield is still jettisoned.

Jettison is the crude answer; the successor is a warehouse ship holding the
material for a later cross-system run — `control-plane-data-plane.md` §10.

---

## Step 3 — The contract buy that could not say why

**Commit:** `b2e6a22` · **Status:** verified

### Defect

DRAGOM-1 shuttled between two waypoints for an hour without buying
anything, on a loop of roughly forty seconds:

```
discovering prices... → docking → orbit → dock → discovering prices...
```

It held a `contractBuy` assignment for DRUGS against a contract paying
181,474c, with **5,497 credits** in the bank. `runContractBuy()` computed
`units = 0` and returned `discoverPrices()` — which tours a market, *reports
success*, and changes nothing about affordability. The dispatcher saw a busy
ship and kept the assignment; the fleet line called it idle.

**All four exits from that function were silent.** Two hours of logs could
not say which was being taken. This is the same failure as the bare `fleet
paused` line: a decision that declines to act must name its reason, or it is
indistinguishable from one that acted.

### Change

Each exit logs. More importantly they split by what could possibly resolve
them:

| Reason | Action | Why |
|---|---|---|
| No price known | tour | the one case touring exists for |
| Cannot afford a unit | trade instead | touring cannot change a bank balance |
| Contract needs no more | trade instead | there is nothing to buy |
| Hold full | return false | neither helps |

`stillNeeded` became its own variable rather than being re-derived from the
`min()`'d cap: once three limits are folded together, a zero no longer says
which produced it, and naming the right reason is the entire point. The
first draft of this fix inferred "contract needs no more" from `cap <= 0`,
which misfires when a full hold is what zeroed it — it would have logged the
wrong reason, which is the disease being treated.

### Proof

- **Tests:** 5 in `tests/contractBuyStall.test.ts`. **4 fail with the source
  stashed.** The fifth is a control — a purchase that should happen still
  reaches `purchaseCargo`.
- **Prediction:** a log line naming the reason. If affordability, DRAGOM-1
  stops shuttling and starts arbitraging. If a different reason appears, the
  affordability diagnosis was wrong and the log says so.
- **Live:** the affordability branch, named, with both numbers:

```
20:34:22  DRAGOM-1: contract buy for DRUGS: cannot afford one unit at 11292c with 8049c in hand; trading instead
20:38:41  DRAGOM-1: contract buy for DRUGS: cannot afford one unit at 11292c with 8393c in hand; trading instead
```

  DRUGS cost 11,292c against a balance of ~8,400c. The shuttling loop is
  gone and the balance is climbing (8,049 → 8,537) as the miners earn while
  the trader falls back to ordinary trading.

### What this makes a doctrine question

"Wait until you can afford it, trade meanwhile" is currently a hardcoded
reaction. As policy it is several real questions: how much of the balance
may one contract buy consume, whether a 181,474c payout justifies committing
the treasury, whether the fleet should earn *toward* a known contract rather
than trade opportunistically. Same for step 2's 80% jettison threshold and
the ore-versus-fuel margin. Each is a constant today that wants to be a
doctrine rule once the mechanics under it are trustworthy — a rule can only
govern a subsystem that functions, and this pass is partly how the decision
points get found.

---

## Step 4 — Repair: the controller proposes, the ship flies

**Commit:** re-land of `5f2a5df` · **Status:** partial — live confirmation pending

### Defect

`maybeRepairFleet()` proposed a repair *and then* claimed the ship, suspended
its loop, and flew it to the yard itself. That is rule 1 — controllers never
call the kubelet — broken by the very controller the rule was written for,
and it produced the failure the rule predicts: `suspend()` resolves only once
the agent's in-flight iteration finishes, so the controller regularly took
ownership of a hull that had just been sent somewhere else. DAGGER-8's repair
"ended at X1-KU72-E49, not X1-KU72-A2".

### Change

Repair is a goal the ship executes. `drivenByFleet()` no longer lists it, so
agents run it rather than standing down on it, through
`ShipProxy.runRepairGoal()` — in the shared executor rather than `ShipAgent`
because any hull can take damage, and a repair every role can be *given* but
only one role can *carry out* would be worse than no change.

Two properties come with it:

- **The controller is level-triggered.** It proposes while the condition
  holds and releases the moment it stops. Without that release a repaired
  hull keeps a committed repair goal forever and flies back to the yard every
  tick. The release sits before any branch that can `continue` past it —
  where the first attempt put it wrongly.
- **`version` is finally read.** `supersedes()` compares the intent a task
  began under against the board now, checked after docking and before
  spending credits. A repair outranked by a rescue in transit, or one whose
  hull recovered on the way, is no longer paid for on arrival. That field was
  written, surfaced on the status line, and read by nothing until now.

`repairPlans` is deleted with `runCriticalRepair()`: a second record of who
owns a hull is what the control-plane split exists to remove.

### History

This commit and `390a63e` were reverted in `c29a540` during a fleet stall I
misdiagnosed four times. The stall's actual cause was the onboarding pause
(`ab87af4`); neither commit was implicated. This is the re-land, one at a
time with a soak each, rather than both at once.

### Added on re-land

`runRepairGoal()` now calls `assertAt(yard, "repair")` before `repairHere()`.
The position re-check above it already guards the common case, but
`ensureDocked()` sits between them and that statement spends credits — step
1's rule applied to code that landed after it. The seam between two changes
is where a gap hides.

The doc merge was resolved by hand rather than taken wholesale: `5f2a5df`'s
version of `control-plane-data-plane.md` also marks step 3 **Done**, which
belongs to `390a63e` and is not re-landed. Taking it would have put a false
claim in the design doc.

### Proof

- **Tests:** 6 in `tests/repairGoal.test.ts`, plus `rescueAndRepair.test.ts`
  rewritten to the new contract — including one that fails if the controller
  suspends or dispatches a hull. 71 pass across the repair, intent, proxy and
  step-1/2/3 files; 174 across the wider non-DB set.
- **Prediction:** a damaged hull produces `repair: heading to <yard>` from
  the *ship*, and no `suspend`/controller-dispatch of that hull. A hull that
  recovers, or is outranked in transit, logs `repair: superseded in transit`
  rather than paying. No repair loop: a repaired hull must not return to the
  yard on the next tick.
- **Live:** _pending._

  Note this step is harder to observe than steps 1–3: it fires only when a
  hull is actually damaged. If no repair occurs during the soak the live
  result will be recorded as "not exercised", not as success.

---

## Open finding — two processes tick the same fleet during a deploy

Found while checking something else, and worth recording before it is lost.

An operator role change (command ship → surveyor) made two instances
disagree about the same hull, which is what made the condition legible:

```
20:42:14  deploy goes live                                   (instance b5qxd)
20:43:04  [b5qxd]  DRAGOM-1(surveyor)@-H56 docked
20:43:05  [4d2vs]  DRAGOM-1(trader)@-H56 transit → X1-S84-H56
20:43:14  [4d2vs]  DRAGOM-3: mining at X1-S84-EC5D    ← last line, mid-command
```

The old instance was not idling out. It was issuing ship commands right up
to the moment it stopped, with its own `TenantWorker`, scheduler and
dispatcher, against the same six hulls. Roughly sixty seconds per deploy.

`shutting down` has never appeared in the logs — not for this deploy, not
for any of the six today. `src/cli/index.ts:105` registers a SIGTERM handler
that calls `registry.stopAll()`; it either never fires or the process dies
before it can log.

**Why it matters.** ADR-0006 makes `ShipRegistry` the single ownership
arbiter — one claim per ship, precedence-ranked, so two authorities cannot
silently fight over a hull. That holds *within a process*. Nothing enforces
it across processes, and ADR-0005's "one long-running process" is an
assumption, never a check. So every deploy opens a window where the
ownership model is simply off, producing the exact class of bug this session
kept chasing: conflicting nav orders, states that should not be reachable,
and double the API call rate against a per-IP limit. Several earlier wrong
diagnoses involved a ship being somewhere the plan did not expect; a deploy
overlap cannot now be ruled out as a contributor to at least one.

**Shape of the fix.** A Postgres advisory lock per tenant, taken by the
worker at boot and released on shutdown, so a second process declines to
tick a tenant another process already owns. Bounded and deploy-only, so not
urgent — but it is mechanics, and it is the same principle as ADR-0006 at a
level nobody enforced.

**Note on attribution.** The manual role change did not cause this; it
exposed it. With both instances agreeing on roles the double-ticking would
have stayed invisible.

---

## Open finding — the panel an operator acts from was not subscribed to data

Found because a hold looked like it had not taken: the ship detail sheet
offered "Under doctrine" and a Hold button for a hull the engine and the
fleet log both reported as `manual hold`. A page refresh showed the Release
button immediately.

`subscribe("bridge", …)` re-rendered the topbar, triage, fleet table, mobile
fleet, hero and summary. It did not re-render the ship detail sheet.
`openShipDetails()` ran once on tap and then only ever again from its own
action buttons, so the sheet froze at whatever the ship was doing when it was
opened while every other panel updated on the five-second poll behind it.

The data was correct in the engine, correct over the wire, and correct in the
store. The one panel an operator issues commands from was the only one not
reading it. Fixed in all four UI versions by adding the open sheet to that
subscription, carrying the half-typed dispatch waypoint (with its cursor) and
the scroll position across the rebuild — a sheet that re-renders every five
seconds and eats your typing is worse than one that never re-renders.

### On real-time UI

The obvious reading of "I had to refresh" is that the data was late and the
answer is server push. It was not: a five-second poll was delivering correct
data into a component that never looked at it again, and SSE would have
delivered the same data to the same unsubscribed panel.

SSE is still worth doing on its own merits — five seconds of latency on every
readout, four polling endpoints per client, `setInterval` under
`document.hidden` being exactly the pattern mobile browsers throttle hardest,
and `EventSource` reconnecting on its own instead of the hand-rolled
visibility-change handling. But it depends on the advisory-lock work above:
an SSE connection pins a client to one process, so with two instances live a
client can hold an open stream to a draining worker and watch a stale fleet
with nothing on screen saying so. Polling hides that by re-resolving every
request; a persistent stream would not.

---

## Step 5 — The trader re-derives its trip from observed state

**Commit:** re-land of `390a63e` · **Status:** partial — live confirmation pending

### Defect

`TraderAgent.runArbitrage()` was the last straight-line procedure in the
engine: navigate, dock, buy, navigate, dock, sell, with no diff between
statements. Under the scheduler it could not even complete — `navigateTo()`
raises `NavigationPending` the moment the ship enters transit, so the tick
ended at the buy and the sell half never ran.

The leftover sweep finished those routes instead, at `bestSell()`'s local
pick rather than the destination the route was chosen for. The signature in
production was `bought 20u MACHINERY …` followed by `cleared leftover 20u
MACHINERY …`, and almost no `sold` lines at all.

### Change

Two reconciled steps over one pinned leg:

- **acquire** — no trip under way, so pick a route, get to `buyAt`, buy, pin
  the leg, end the tick;
- **deliver** — cargo carrying a pin, so get to that leg's `sellAt`, and sell
  only once standing there.

Each entry re-derives from observed state, so a move that fails simply makes
no progress. That is `MissionManager.stepCarrier()`'s shape, which is why the
carrier never had these bugs. The sweep goes back to what its name says:
cargo with no trip behind it.

This closes step 3 of the migration. `control-plane-data-plane.md` §8 now
reads four built, two half-built, which for the first time matches its own
heading — the table had said three and three under a heading claiming four.

### History and seam check

Reverted in `c29a540` alongside the repair commit, during a stall neither
caused. `trader.ts` auto-merged with the contract-buy work from step 3 of
this pass; both survive intact (`cannot afford one unit at …` and
`stillNeeded` still present alongside `deliverHeldCargo()`).

Unlike the repair re-land, no rule 5 assertion had to be added:
`deliverHeldCargo()` already calls `assertAt(leg.sellAt, …)` before selling.
Checked rather than assumed, since the seam between two changes is where a
gap hides.

### Proof

- **Tests:** `tests/tradeReconcile.test.ts`. 155 pass across the trader,
  repair, intent, proxy and step-1/2/3 files.
- **Prediction:** `sold Nu GOOD @ Pc at <sellAt> (+Nc)` lines — the signed
  delta is new, and the waypoint must be the leg's `sellAt`, not a local
  pick. `cleared leftover` must stop following buys; any that remain should
  be genuine orphans (crash recovery, failed warehouse deposit), not
  completed routes. A buy on one tick and its sell on a later one, rather
  than a buy with no matching sell.
- **Live:** _pending._

---

## Step 6 — Contract deliveries and payouts were invisible

**Commit:** `d21e32b` · **Status:** verified

### Defect

Found by pushing on a wrong assumption of mine. I had described the trader as
having no work available; it was assigned a contract and was filling it. The
reason neither of us could see that:

```
17:35:14  DRAGOM-1: bought 3u DRUGS @ 11164c at X1-S84-H56 for contract delivery
17:36:01  DRAGOM-1(trader)@-H56 … c0/40
```

33,492c of cargo — a third of the fleet's capital — left the hold 47 seconds
after purchase, and there is no line anywhere recording where it went.
`ContractManager.deliverVia()` called `api.deliverContract()` and then logged
nothing, recorded no activity and wrote no ledger row. From outside the
fleet, "delivered against the contract" and "destroyed by a bug" were
indistinguishable; establishing which took a source read and a timestamp
cross-reference against the deploy history.

`fulfillCompleted()` was worse. A payout is real money, and with no ledger
row it never reached `ledgerSummary()`. Buying contract goods was booked as
cost while the revenue justifying it was booked nowhere — so a fleet working
a profitable contract reads as one bleeding money.

**This corrupted every economic figure in this document.** The
`net -81437c … bought -33492` line quoted around step 2 counted the DRUGS as
a pure loss. My "the loop runs at a loss" claim was computed from books with
one of the fleet's largest value transfers missing from them.

### Change

- `deliverVia()` logs units, good, contract id and progress (`5/10`), and
  reports `contract-deliver` activity. No ledger row: a delivery moves goods,
  not credits, and the purchase that bought them is already booked.
- `fulfillCompleted()` logs the payout, reports `contract-fulfilled`
  activity, and writes a `CONTRACT` ledger row.
- `ledgerSummary()` gains `contract` **and adds it to `net`**. Grouping a row
  without counting it would have kept the same lie in a tidier shape.
- The earnings line now carries `contracts +N`.
- `ContractManager` gains the reporting callbacks it never had;
  `tenantRegistry` extracts one shared activity recorder so a delivery
  reaches the dashboard and Discord by the same path as every other event,
  rather than a parallel copy.

### Proof

- **Tests:** 6 in `tests/contractVisibility.test.ts`. **4 fail with the
  source stashed.** The other 2 are silence controls — nothing is said for a
  delivery that did not happen or a contract that is not finished, since a
  log line for a non-event is the same disease.
- **Prediction:** the next delivery logs `delivered Nu DRUGS to contract
  … (x/10)`; the earnings line carries a `contracts +N` field; when the
  contract completes, `fulfilled — 181474c paid` appears and `net` jumps by
  that amount rather than the credits moving unexplained.
- **Live:**

```
21:39:48  DRAGOM-1: bought 1u DRUGS @ 11328c at X1-S84-H56 for contract delivery
21:40:01  DRAGOM-1: delivered 1u DRUGS to contract cmtq3cdo at X1-S84-H56 (4/22)
21:34:04  earnings 15m: … sold +2041 · contracts +0 · bought -0 …
```

  The delivery announces itself with progress, and `contracts` is in the
  earnings line. Thirteen seconds from buy to delivery, on a path that until
  now produced no output at all.

### What the fix immediately exposed

The `(4/22)` is the point. Twenty-two units at ~11,300c is ~248,700c to
fulfil a contract paying 181,474c — a **~67,000c guaranteed loss**, accepted
four hours earlier and worked ever since. The number was unknowable while
deliveries were silent, which is the argument for the fix stated better than
I could state it: an instrumentation gap is not cosmetic when it hides a
decision this size. Logged as bug-log #2.

### Note on method

This one was not on the queue. It surfaced because a wrong claim of mine was
challenged, and the challenge was right. Worth recording as its own kind of
evidence: the fastest way to find a silent subsystem was to state something
confidently wrong about it in front of someone who knew better.

---

## Step 7 — The cash floor the trader spent straight through

**Commit:** `0830793` · **Status:** verified

**Migration step:** 2 — single source of truth, read by reference. The
nominated source exists and the call sites read around it, which is the same
shape as agents keeping private copies of the world.

### Defect

Reported by the operator: a doctrine rule set so the fleet buys nothing but
fuel below a threshold, not being obeyed.

The rule was not missing. `cashFloor` is adopted by default, `enabled`,
`enforced`, and says exactly that: *"the catch-all floor for every purchase
(ships, modules, repairs, cargo). Fuel is always exempt."*

`trader.ts` never consulted it. All three purchase sites read the raw agent
balance, and `fleet.ts:486` had already documented the hole without closing
it:

> several real spending paths (a trader's own arbitrage/contract buying,
> repairShip(), a manual dashboard buy) never checked it at all — a trader
> could spend the fleet to zero on one big cargo buy with nothing stopping it

Observed live at 21:39:48: holding ~11,400c against a 20,000c floor, DRAGOM-1
bought 1u DRUGS for 11,328c and was left with about a hundred credits. It was
already under the floor before the purchase.

### Change

The live read stays — it is deliberate, and the reason is documented at the
call site: the fleet's cached balance is refreshed once per tick and goes
stale the moment another ship spends, so swapping it for the cached-but-
floored `getCredits()` would trade this bug for that one. `spendableNow()`
takes the live balance and applies the floor to it, and the three sites call
that one method rather than each remembering to subtract.

`getCredits()` stays as it was for route *ranking*, where the cached figure
is fine. The two answer different questions and now say so.

### Proof

- **Tests:** 6 in `tests/cashFloor.test.ts`. **5 fail with the source
  stashed.** The sixth is a control — a fleet with headroom above the floor
  still buys, so the floor cannot become a blanket refusal.
- **Prediction:** no further `bought Nu DRUGS` lines while the balance is
  under 20,000c; the contract-buy path reports `cannot afford one unit …`
  with the *spendable* figure rather than the raw balance, and falls through
  to trading. Mining income accumulates instead of being spent down.
- **Live:**

```
22:49:28  DRAGOM-1: contract buy for DRUGS: cannot afford one unit at 11350c with 0c in hand; trading instead
22:49:38  earnings 15m: net +1185c (+4740c/hr) — sold +2409 · contracts +0 · bought -0 · … · 18 sales
```

  `with 0c in hand` is the proof: that is the spendable figure — live balance
  minus the 20,000c floor, clamped at zero — where the same line reported the
  raw balance (`10107c`, `10368c`) before the fix. `bought -0` in every window
  since. The ~67,000c contract bleed stopped without needing the abandon
  control.

---

## Step 8 — The operator hold becomes an intent

**Commit:** `ea6b622` + this one · **Status:** partial — live confirmation pending

**Migration step:** 4 — manual dispatch as a `hold` intent. Half of it; see
"What is left" below.

### Defect

`holdShip()` called `agent.dispatchTo()`, which set a private `manualGoal`
field **and** flew the hull from inside the fleet. Two faults in one call:

- **Rule 1.** The controller touched the kubelet, exactly as the repair
  controller did before step 5.
- **A second ownership record.** `isManual()` answered from the agent while
  the arbiter answered from the intent board. They could disagree, and they
  did: an operator pressed Hold, watched the ship sheet keep reporting "Under
  doctrine", and reasonably concluded the button had not worked. The engine
  and the fleet log said `manual hold` at the same moment.

### Change

`hold` splits by whether it names a waypoint. With one, it is an operator
parking a hull and the ship flies it through `ShipProxy.runHoldGoal()` —
position re-derived each tick, so a hold placed on a moving ship simply
completes on arrival. Without one, it is still the arbiter saying "nothing
worth doing", where standing down *is* executing it, so it stays in
`drivenByFleet()`.

`holdShip()` now only persists the instruction. `proposeOperatorHolds()`
re-proposes it every tick from an in-memory mirror of that state — level
triggered, like every other controller, so releasing is the proposal
stopping. It is proposed first so its priority-0 tie beats rescue's own
priority-0 hold, matching the precedence `ShipRegistry` already enforces
(operator > rescue).

`getShipStatuses()` reports `paused` from `FleetManager.isHeld()` — the same
map the controller reads. One source, so the disagreement that started this
is now unrepresentable. The per-tick database read went away with it.

### Proof

- **Tests:** 5 in `tests/operatorHold.test.ts`, plus `intentConsumption` and
  `fleetStatusSummary` moved to the new contract. **8 fail with the source
  stashed.** 267 pass across every non-DB file.
- **Two existing tests asserted the old contract and were rewritten, not
  bent back:** a hold-with-waypoint is now flown rather than stood down on,
  and a ship is made held by seeding the fleet's map rather than by faking
  the agent's flag — which is the point of the change.
- **Prediction:** pressing Hold logs `SHIP: operator hold at WP` from the
  fleet and then `hold: heading to WP (held at WP by the operator)` from the
  *ship* if it is elsewhere; the sheet shows Held on the next poll without a
  refresh; Release stops the proposal and the ship returns to doctrine work.
  No `manual dispatch → …` line, since the fleet no longer flies it.
- **Live:** _pending._

### Closing it: moving a ship stops meaning owning it

The second commit finishes the step. The insight that made it small: of the
ten callers of `dispatchShip()`, **nine are internal errands** — reach a jump
gate, get to a shipyard to buy, station a keeper — that only ever wanted the
hull to *move*. Exactly one, the dashboard's "Send to waypoint", wanted it to
stay. `dispatchTo()` served both by flying the ship *and* setting a private
flag that took it off the board.

That side effect was a latent bug in its own right, and the codebase already
carried the scar: `exploreSystem()` wraps its trip in a `try/finally` that
releases the ship, purely to undo a hold nobody asked for — without it, "a
scout left this way never gets picked again".

So `dispatchTo()` is now a movement primitive in every agent, and the one
caller that wants the ship to stay says so: `sendShipTo()` places a hold at
the destination and then moves the hull, which is what that control's own
label has always promised.

`manualGoal` / `manualWaypoint` are gone from `ShipAgent`, `TraderAgent` and
`SiphonerAgent`, along with their `isManual()`. `ScoutAgent` keeps a
`manualGoal`, deliberately: there it means "chart *this* target next", an
override of *what to do* like `mineAt()`, not a claim on the hull.

The four places that asked an agent whether it was available now ask
`FleetManager.isHeld()`. `ControlledAgent` no longer declares `isManual()` at
all, so the disagreement that started this — the dashboard reading the agent
while the arbiter read the board — is not merely fixed but unrepresentable.

### Proof of the closing half

- **Tests:** 2 added. **One fails with the source stashed** — the other
  exercises `isHeld()`, which landed in the first commit, so it correctly
  passes against `HEAD`. 266 pass across every non-DB file; the 4 failures
  are `ECONNREFUSED` in the DB-backed `agentStep.test.ts`.
- **Prediction:** `dispatch → WP` replaces `manual dispatch → WP` in the
  logs. A ship sent on an internal errand (a scout reaching its gate, a hull
  going to a yard to buy) is picked for automatic work again afterwards
  rather than sitting benched. "Send to waypoint" still parks the ship, now
  reported as `operator hold at WP`.
- **Live:** _pending._

---

## Queue

| # | Step | Status |
|---|---|---|
| 1 | Rule 5 at remaining transaction sites | verified |
| 2 | Cargo-residue deadlock | verified |
| 3 | Contract-buy silent stall | verified |
| 4 | Repair: controller proposes, ship flies | tests only — not exercised live (no hull damaged) |
| 5 | Trader re-derives trip from observed state | tests only — not exercised live (trader never traded) |
| 6 | Contract deliveries and payouts made visible | verified |
| 7 | Cash floor honoured by trader purchases | verified |
| 8 | Step 4 closed — one owner per hull | live confirmation pending |
| 9 | `priceTable` → registry (single source of truth for prices) | not started |
| 7 | Finish steps 3/4/5 of the migration — the executor fault line | not started |
| 8 | Multi-hop routing | not started |
| 9 | Jump-gate construction status | not started |

Steps 4–9 and their rationale are in `control-plane-data-plane.md` §8 and
§10. The ordering principle: do the loud-failure work before the structural
work, so that when a refactor breaks something it screams instead of
silently mis-trading.
