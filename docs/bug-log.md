# Bug log

Reported or observed, not yet fixed. Each entry says what was seen, what is
known about the cause, and what is still assumption — so nothing here is
mistaken for a diagnosis that has actually been made.

Fixed items move to `subsystem-verification.md` with their evidence. This
file is only the open list.

Each entry names the migration step it belongs to
(`control-plane-data-plane.md` §8), so that fixing it reads as finishing the
implementation rather than as a pile of unrelated repairs — and so the ones
that are genuinely *new policy* are visible as such and can wait for the
doctrine pass.

| # | Open item | Migration step |
| --- | --- | --- |
| 1 | Contract acceptance takes a loss | **rule 5** for the silent-zero half; **doctrine** for the margin gate |
| 2 | No way to abandon a contract | **step 4** — manual dispatch as a `hold` intent |
| 3 | Two processes tick one fleet | ADR-0006 at process level; infrastructure, not a step |
| 4 | Live UI updates (SSE) | **step 6** family — delivery of telemetry, not new telemetry |
| 5 | A trader assigned work it cannot fund, forever | **doctrine** — the dispatcher has no affordability gate |
| 6 | "0c in hand" is not the balance | **rule 5** family — a number that does not mean what it says |

---

## 1. Contract acceptance can take a guaranteed loss

**Confirmed, with numbers.** Contract `cmtq3cdo` needs 22 units of DRUGS at
~11,300c — about 248,700c to fulfil — against a payout of 181,474c. A
**~67,000c guaranteed loss**, accepted at 17:33 and worked ever since. It sat
undetected for four hours because deliveries were silent; the `(4/22)` that
made it visible only exists because of the contract-visibility fix.

Two independent defects in `acceptBest()` (`contract.ts:140`), either
sufficient on its own:

- **Unknown sourcing cost is treated as free.** `if (cheapest) sourcingCost
  += …` — with no market snapshots, cost stays 0 and the score becomes raw
  payout. This contract was accepted seconds after onboarding, when the fleet
  had no market intel at all. The class comment documents the degradation as
  deliberate; it is the same silent-fallback pattern this pass keeps finding.
- **No sign check.** `scored.sort(...)` then accept `scored[0]` — the
  least-bad contract is accepted however negative it is. There is no "decline
  them all" branch.

**Shape of the fix.** Unknown cost must not read as zero — an unpriceable
deliverable makes the contract unscoreable, not free. Add a minimum-margin
gate rather than accepting whatever ranks first, and log the decision with
its numbers so an accept or a decline can be read back. The margin belongs in
doctrine, not in a hardcoded `> 0`.

---

## 2. No way to abandon a contract

**Requested.** An operator needs to be able to cancel a contract from the UI.

**Constraint worth knowing before designing it.** The SpaceTraders API has
`accept`, `deliver`, `fulfill` and `negotiate` — and no cancel. An accepted
contract cannot be handed back; it can only be completed or allowed to
expire, and expiry costs reputation.

So "abandon" can only mean: stop *working* it. Release the trader, drop the
`contractBuy` assignment, stop sourcing the good, and let it lapse. The UI
should say that plainly rather than offering a Cancel button that implies
something the API cannot do — the honest control is "stop working this
contract", with the reputation consequence stated.

`ContractManager` already has a `declined` set, but it only covers contracts
that were never accepted.

Now cheaper than it was: the operator hold is an intent as of step 8, so
"stop working this contract" is the same shape — persist the instruction,
propose it each tick, let the dispatcher stop assigning the good. It no
longer needs a new ownership channel of its own.

---

## 3. Two processes tick the same fleet during a deploy

Moved from `subsystem-verification.md`'s open findings; see that file for the
full evidence. Roughly sixty seconds per deploy where an old and a new
instance both run a `TenantWorker` against the same hulls, with `shutting
down` never appearing in the logs. Fix shape: a per-tenant Postgres advisory
lock. Blocks SSE, which would otherwise pin a client to a draining process.

---

## 4. Live UI updates (SSE)

Not a bug — a wanted change, recorded so it is not confused with the ship
sheet fix that was mistaken for it. Five-second polling, four endpoints per
client, and `setInterval` under `document.hidden` is what mobile browsers
throttle hardest. Wants the advisory lock (3) first.

---

## 5. A trader stays assigned to work it cannot fund

**Observed live, 23:28.** `DRAGOM-1: contract buy for DRUGS: cannot afford
one unit at 11350c with 0c in hand; trading instead`, immediately followed by
`discovering prices...`, a dock, an orbit, and a move — and on the next tick
`dispatch recompute: 1 traders (1 idle) | work: DRUGS:contractBuy=181474 |
assigned: DRAGOM-1:DRUGS(contractBuy)` re-assigns the same good. That
recompute line is identical every minute from 22:51 to 23:29.

The step-3 fix did its job: the ship now *says* it cannot afford the buy and
goes to trade instead. What it cannot do is shed the assignment. The
dispatcher scores `DRUGS:contractBuy` at its payout (181,474c) with no regard
for whether the ship can raise the ~11,350c entry price, so the assignment is
re-made every tick and the trader oscillates between two waypoints
discovering prices it will never act on.

This is the *legible* version of the hour of shuttling step 3 was written
for — the loop is the same, but it now narrates itself. That is the fix
working, and it is also not enough: **an assignment no ship can execute
should not keep being made.** The gate belongs with the dispatcher's scoring,
next to the margin gate in item 1, and both are doctrine.

Compounding: this particular contract is item 1's ~67,000c guaranteed loss.
The trader is permanently assigned to work that is both unaffordable and, if
it ever became affordable, unprofitable.

---

## 6. "0c in hand" is not the balance

`spendableCredits()` returns `max(0, credits - cashFloor)`, and
`spendableNow()` is what the affordability message prints as *"in hand"*. So
`with 0c in hand` means **"nothing above the 20,000c floor"**, not "broke" —
the agent may hold up to the entire floor.

Small, and exactly the class of thing this pass exists to remove: a log line
whose number does not mean what its words say. Someone reading it — including
me, for a moment — concludes the fleet is bankrupt. Say
`0c spendable (20000c floor)` or print both figures.
