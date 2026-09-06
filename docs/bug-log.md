# Bug log

Reported or observed, not yet fixed. Each entry says what was seen, what is
known about the cause, and what is still assumption — so nothing here is
mistaken for a diagnosis that has actually been made.

Fixed items move to `subsystem-verification.md` with their evidence. This
file is only the open list.

---

## 1. The cash floor is bypassed by every trader purchase path

**Reported as:** a doctrine rule set so that below a threshold the fleet buys
nothing but fuel — and it is not being obeyed.

**Confirmed, including the intent.** The rule exists and already says exactly
that. `doctrine.ts`, `cashFloor`, default 20,000c, `enabled: true`,
`enforced: true`:

> "Never let the balance fall below this — the catch-all floor for every
> purchase (ships, modules, repairs, cargo). **Fuel is always exempt.**"

So nothing needs designing. The rule is right, adopted by default, and simply
never consulted on the paths that matter.

`fleet.ts:291` wires `getCredits()` to `spendableCredits()`, the
floor-adjusted figure, and `fleet.ts:512` even has a `canAfford()` built on
it. But `trader.ts` reads the raw agent balance at all three of its purchase
sites — lines 1247, 1319 and 1539:

```ts
const liveCredits = (await this.api.getMyAgent()).credits;
```

`getCredits()` appears in that file only at lines 775 and 816, neither of
them a purchase. So every trader buy sizes itself against the entire balance
and the floor never enters the arithmetic.

Observed live: at 21:39:48 the fleet held roughly 11,400c and bought 1u DRUGS
for 11,328c, leaving about a hundred credits — with a 20,000c floor set. It
should not have bought at all; the balance was already under the floor before
the purchase.

Fuel is correctly exempt by accident of routing rather than by rule: refuel
goes through `api.refuelShip()` directly and never passes a credit check at
all.

**Shape of the fix.** Route the three purchase sites through `getCredits()`
so the floor applies by construction rather than by each call site
remembering to ask. Worth a test per site that fails without it, since this
is the third distinct bug today whose cause was a call site quietly reading
a different source than the one the design nominated.

---

## 2. Contract acceptance can take a guaranteed loss

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

## 3. No way to abandon a contract

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

## 4. Two processes tick the same fleet during a deploy

Moved from `subsystem-verification.md`'s open findings; see that file for the
full evidence. Roughly sixty seconds per deploy where an old and a new
instance both run a `TenantWorker` against the same hulls, with `shutting
down` never appearing in the logs. Fix shape: a per-tenant Postgres advisory
lock. Blocks SSE, which would otherwise pin a client to a draining process.

---

## 5. Live UI updates (SSE)

Not a bug — a wanted change, recorded so it is not confused with the ship
sheet fix that was mistaken for it. Five-second polling, four endpoints per
client, and `setInterval` under `document.hidden` is what mobile browsers
throttle hardest. Wants the advisory lock (4) first.
