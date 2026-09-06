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
