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

**Commit:** `b2e6a22` · **Status:** partial — live confirmation pending

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
- **Live:** _pending — soak in progress at time of writing._

---

## Queue

| # | Step | Status |
|---|---|---|
| 1 | Rule 5 at remaining transaction sites | verified |
| 2 | Cargo-residue deadlock | verified |
| 3 | Contract-buy silent stall | live confirmation pending |
| 4 | Re-land `5f2a5df` — repair: controller proposes, ship flies | not started |
| 5 | Re-land `390a63e` — trader re-derives trip from observed state | not started |
| 6 | `priceTable` → registry (single source of truth for prices) | not started |
| 7 | Finish steps 3/4/5 of the migration — the executor fault line | not started |
| 8 | Multi-hop routing | not started |
| 9 | Jump-gate construction status | not started |

Steps 4–9 and their rationale are in `control-plane-data-plane.md` §8 and
§10. The ordering principle: do the loud-failure work before the structural
work, so that when a refactor breaks something it screams instead of
silently mis-trading.
